import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { UserFacingError } from "../shared";
import type { TranscriptionProvider, TranscriptionSession } from "./index";
const RATE = 16000; // whisper.cpp expects 16 kHz mono PCM16
const MIN_CHUNK_SECONDS = 4;
const MAX_CHUNK_SECONDS = 15;
const PAUSE_SECONDS = 0.5;
const SPEECH_RMS = 0.01; // about -40 dBFS; quieter audio is treated as silence
const MAX_BACKLOG_SECONDS = 90;
export type WhisperServer = {
  url: string;
  /** Resolves with a reason if the process exits on its own. */
  exited: Promise<string>;
  stop(): Promise<void>;
};
type Input = Parameters<TranscriptionProvider["connect"]>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (path: string) =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
export async function launchWhisperServer(
  serverPath: string,
  modelPath: string,
  timeoutMs = 60000,
): Promise<WhisperServer> {
  const port = await freePort();
  const child = spawn(
    serverPath,
    [
      "-m",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-l",
      "en",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Keep a little stderr only to explain a failed startup; after that it may
  // contain transcript text, so it is drained without being retained.
  let startupLog = "";
  const collect = (data: Buffer) => {
    startupLog = (startupLog + data.toString()).slice(-2000);
  };
  child.stderr.on("data", collect);
  let exitReason: string | undefined;
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve((exitReason = error.message)));
    child.once("exit", (code, signal) =>
      resolve((exitReason = `exited (${signal ?? code})`)),
    );
  });
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (exitReason !== undefined) return;
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(3000)]);
    if (exitReason === undefined) child.kill("SIGKILL");
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exitReason !== undefined) {
      const detail = startupLog.trim().split("\n").at(-1) ?? exitReason;
      throw new UserFacingError(`Local Whisper could not start: ${detail}`);
    }
    try {
      const response = await fetch(url + "/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      // Still loading the model.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new UserFacingError(
        "Local Whisper did not become ready within 60 seconds. Try a smaller model.",
      );
    }
    await sleep(250);
  }
  child.stderr.off("data", collect);
  child.stderr.resume();
  startupLog = "";
  return { url, exited, stop };
}
/** Averages source samples per output sample: a crude low-pass that suits speech. */
export function resampleTo16k(input: Int16Array, rate: number): Int16Array {
  if (rate === RATE) return input;
  const ratio = rate / RATE;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(
      input.length,
      Math.max(start + 1, Math.floor((i + 1) * ratio)),
    );
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = Math.round(sum / (end - start));
  }
  return out;
}
export function encodeWav(pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return bytes;
}
/** Whisper marks non-speech as [BLANK_AUDIO], [Music], (silence) and so on. */
export function cleanWhisperText(text: string) {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/^\s*\([^)]*\)\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function inferenceForm(pcm: Int16Array) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([encodeWav(pcm)], { type: "audio/wav" }),
    "audio.wav",
  );
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  return form;
}
export class WhisperCppProvider implements TranscriptionProvider {
  constructor(
    private options: {
      model: string;
      modelPath: string;
      serverPath: string | null;
      launch?: typeof launchWhisperServer;
      request?: typeof fetch;
    },
  ) {}
  async preflight() {
    if (!(await exists(this.options.modelPath)))
      throw new UserFacingError(
        `The Local Whisper ${this.options.model} model is missing. Expected it at ${this.options.modelPath}. Download it (README → Personal Zero-Cost Setup) or choose another transcription provider in Settings.`,
      );
    if (!this.options.serverPath)
      throw new UserFacingError(
        "whisper-server was not found. Install whisper.cpp (macOS: brew install whisper-cpp) or set WHISPER_SERVER_PATH.",
      );
  }
  private launch() {
    return (this.options.launch ?? launchWhisperServer)(
      this.options.serverPath!,
      this.options.modelPath,
    );
  }
  /** Loads the model and transcribes half a second of silence. */
  async test() {
    await this.preflight();
    const started = Date.now();
    const server = await this.launch();
    try {
      const response = await (this.options.request ?? fetch)(
        server.url + "/inference",
        { method: "POST", body: inferenceForm(new Int16Array(RATE / 2)) },
      );
      if (!response.ok)
        throw new UserFacingError(
          `Local Whisper loaded but failed a test transcription (${response.status}).`,
        );
    } finally {
      await server.stop();
    }
    return `Ready — ${this.options.model} model loaded and responded in ${((Date.now() - started) / 1000).toFixed(1)} s`;
  }
  async connect(input: Input): Promise<TranscriptionSession> {
    await this.preflight();
    const server = await this.launch();
    const request = this.options.request ?? fetch;
    input.onEvent({
      type: "connection",
      status: "connected",
      message: `Local Whisper (${this.options.model}) · audio stays on this device`,
    });
    let buffer: Int16Array[] = [];
    let buffered = 0;
    let pause = 0;
    let speech = false;
    let timeline = 0; // 16 kHz samples before the current buffer
    const queue: { pcm: Int16Array; start: number }[] = [];
    let queued = 0;
    let worker: Promise<void> | null = null;
    let closed = false;
    let failed = false;
    let behindReported = false;
    void server.exited.then(() => {
      if (closed) return;
      failed = true;
      input.onEvent({
        type: "connection",
        status: "failed",
        message:
          "Local Whisper stopped unexpectedly. Stop the meeting; the transcript so far and your notes are saved.",
      });
    });
    const ms = (samples: number) => Math.round((samples / RATE) * 1000);
    const transcribe = async (chunk: { pcm: Int16Array; start: number }) => {
      try {
        const response = await request(server.url + "/inference", {
          method: "POST",
          body: inferenceForm(chunk.pcm),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw new Error(`Whisper ${response.status}`);
        const text = cleanWhisperText(
          ((await response.json()) as { text?: string }).text ?? "",
        );
        if (!text) return;
        input.onEvent({
          type: "final",
          segment: {
            id: crypto.randomUUID(),
            meetingId: input.meetingId,
            speaker: "Speaker",
            text,
            startTimeMs: ms(chunk.start),
            endTimeMs: ms(chunk.start + chunk.pcm.length),
            confidence: 0,
            createdAt: new Date().toISOString(),
          },
        });
      } catch {
        if (!failed)
          input.onEvent({
            type: "connection",
            status: "reconnecting",
            message:
              "A few seconds of speech could not be transcribed locally. Transcription continues.",
          });
      }
    };
    // One chunk at a time: whisper.cpp already uses every core it is given.
    const pump = () => {
      if (worker) return;
      worker = (async () => {
        while (queue.length && !failed) {
          const chunk = queue.shift()!;
          queued -= chunk.pcm.length;
          await transcribe(chunk);
        }
      })().finally(() => {
        worker = null;
      });
    };
    const cut = () => {
      if (!buffered) return;
      const pcm = new Int16Array(buffered);
      let offset = 0;
      for (const part of buffer) {
        pcm.set(part, offset);
        offset += part.length;
      }
      const start = timeline;
      timeline += buffered;
      const hadSpeech = speech;
      buffer = [];
      buffered = 0;
      pause = 0;
      speech = false;
      if (!hadSpeech) return; // silence is discarded without leaving memory
      queue.push({ pcm, start });
      queued += pcm.length;
      while (queued > MAX_BACKLOG_SECONDS * RATE) {
        queued -= queue.shift()!.pcm.length;
        if (!behindReported) {
          behindReported = true;
          input.onEvent({
            type: "connection",
            status: "reconnecting",
            message:
              "Local transcription is falling behind, so some older audio was skipped. Choose a smaller Whisper model in Settings.",
          });
        }
      }
      pump();
    };
    return {
      send(data) {
        if (closed || failed) return;
        const samples = new Int16Array(
          data.buffer.slice(
            data.byteOffset,
            data.byteOffset + (data.byteLength & ~1),
          ),
        );
        const pcm = resampleTo16k(samples, input.sampleRate);
        let energy = 0;
        for (const v of pcm) energy += (v / 32768) ** 2;
        if (pcm.length && Math.sqrt(energy / pcm.length) >= SPEECH_RMS) {
          speech = true;
          pause = 0;
        } else pause += pcm.length;
        buffer.push(pcm);
        buffered += pcm.length;
        const seconds = buffered / RATE;
        if (
          (seconds >= MIN_CHUNK_SECONDS && pause >= PAUSE_SECONDS * RATE) ||
          seconds >= MAX_CHUNK_SECONDS
        )
          cut();
      },
      async close() {
        if (closed) return;
        cut();
        closed = true;
        const drained = await Promise.race([
          (async () => {
            while (worker) await worker;
            return true;
          })(),
          sleep(90000).then(() => false),
        ]);
        await server.stop();
        input.onEvent({ type: "connection", status: "closed" });
        if (!drained)
          throw new Error(
            "Local transcription finalization timed out. The last few words may be missing.",
          );
      },
    };
  }
}
