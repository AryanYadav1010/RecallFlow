import WebSocket from "ws";
import { z } from "zod";
import type { TranscriptionEvent } from "../shared";
export interface TranscriptionSession {
  send(data: Buffer): void;
  close(): Promise<void>;
}
export interface TranscriptionProvider {
  /** Fails fast with a user-facing reason before a meeting is started. */
  preflight?(): Promise<void>;
  connect(input: {
    meetingId: string;
    sampleRate: number;
    onEvent: (event: TranscriptionEvent) => void;
  }): Promise<TranscriptionSession>;
}
type Input = Parameters<TranscriptionProvider["connect"]>[0];
export const MOCK_LINES = [
  "This is a sample product planning meeting. We are reviewing the onboarding experience.",
  "We decided to simplify the welcome screen before the next release.",
  "Alex will prepare the revised onboarding draft by Friday.",
  "Our target is to reduce setup time from ten minutes to five minutes.",
  "We need to confirm whether the design review can happen next week.",
  "A blocker is that the analytics specification has not been approved yet.",
];
export class MockTranscriptionProvider implements TranscriptionProvider {
  async connect(input: Input) {
    let index = 0;
    let tick = 0;
    input.onEvent({
      type: "connection",
      status: "connected",
      message:
        "Mock transcription: scripted sample text, not speech recognition.",
    });
    const timer = setInterval(() => {
      if (index >= MOCK_LINES.length) return;
      tick++;
      if (tick % 2 === 1)
        input.onEvent({
          type: "partial",
          text: MOCK_LINES[index].slice(0, 45),
        });
      else {
        input.onEvent({
          type: "final",
          segment: {
            id: crypto.randomUUID(),
            meetingId: input.meetingId,
            speaker: `Sample speaker ${(index % 2) + 1}`,
            text: MOCK_LINES[index],
            startTimeMs: index * 5000,
            endTimeMs: (index + 1) * 5000,
            confidence: 1,
            createdAt: new Date().toISOString(),
          },
        });
        index++;
      }
    }, 2500);
    return {
      send: (_data: Buffer) => {},
      close: async () => {
        clearInterval(timer);
        input.onEvent({ type: "connection", status: "closed" });
      },
    };
  }
}
const Word = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number(),
  end: z.number(),
  speaker: z.number().optional(),
  confidence: z.number().optional(),
});
const Result = z.object({
  type: z.literal("Results"),
  is_final: z.boolean(),
  start: z.number(),
  duration: z.number(),
  channel: z.object({
    alternatives: z.array(
      z.object({
        transcript: z.string(),
        confidence: z.number().optional(),
        words: z.array(Word).optional(),
      }),
    ),
  }),
});
export function parseDeepgram(
  value: unknown,
  input: { meetingId: string; offset: number; session: number },
): TranscriptionEvent[] {
  const parsed = Result.safeParse(value);
  if (!parsed.success) return [];
  const result = parsed.data;
  const alternative = result.channel.alternatives[0];
  if (!alternative?.transcript.trim()) return [];
  if (!result.is_final)
    return [{ type: "partial", text: alternative.transcript }];
  const groups: {
    speaker: string;
    text: string;
    start: number;
    end: number;
  }[] = [];
  for (const word of alternative.words ?? []) {
    const speaker =
      word.speaker === undefined
        ? "Speaker"
        : `Speaker ${word.speaker + 1} · stream ${input.session}`;
    const last = groups.at(-1);
    if (last?.speaker === speaker) {
      last.text += " " + (word.punctuated_word ?? word.word);
      last.end = word.end;
    } else
      groups.push({
        speaker,
        text: word.punctuated_word ?? word.word,
        start: word.start,
        end: word.end,
      });
  }
  if (!groups.length)
    groups.push({
      speaker: "Speaker",
      text: alternative.transcript,
      start: result.start,
      end: result.start + result.duration,
    });
  return groups.map((g) => ({
    type: "final",
    segment: {
      id: crypto.randomUUID(),
      meetingId: input.meetingId,
      speaker: g.speaker,
      text: g.text,
      startTimeMs: Math.round(input.offset + g.start * 1000),
      endTimeMs: Math.round(input.offset + g.end * 1000),
      confidence: alternative.confidence ?? 0,
      createdAt: new Date().toISOString(),
    },
  }));
}
export class DeepgramProvider implements TranscriptionProvider {
  constructor(
    private apiKey: string,
    private endpoint = "wss://api.deepgram.com/v1/listen",
    private retryDelay = 1000,
  ) {}
  async connect(input: Input): Promise<TranscriptionSession> {
    let socket: WebSocket;
    let closing = false;
    let attempt = 0;
    let session = 0;
    let bytesSeen = 0;
    let offset = 0;
    let queue: Buffer[] = [];
    let queueBytes = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let gapReported = false;
    const budget = input.sampleRate * 2 * 5;
    const connect = () =>
      new Promise<void>((resolve, reject) => {
        const url = new URL(this.endpoint);
        for (const [k, v] of Object.entries({
          model: "nova-3",
          encoding: "linear16",
          sample_rate: String(input.sampleRate),
          channels: "1",
          interim_results: "true",
          smart_format: "true",
          diarize_model: "v1",
          endpointing: "300",
          mip_opt_out: "true",
        }))
          url.searchParams.set(k, v);
        const ws = new WebSocket(url, {
          headers: { Authorization: `Token ${this.apiKey}` },
          handshakeTimeout: 10000,
          maxPayload: 1024 * 1024,
        });
        socket = ws;
        let opened = false;
        session++;
        ws.on("open", () => {
          if (closing) {
            ws.close();
            return reject(new Error("Capture stopped"));
          }
          opened = true;
          offset = ((bytesSeen - queueBytes) / (input.sampleRate * 2)) * 1000;
          input.onEvent({
            type: "connection",
            status: "connected",
            message:
              session > 1
                ? "Reconnected. Some speech around the interruption may be missing."
                : undefined,
          });
          for (const chunk of queue) ws.send(chunk);
          queue = [];
          queueBytes = 0;
          heartbeat = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify({ type: "KeepAlive" }));
          }, 4000);
          resolve();
        });
        ws.on("message", (data) => {
          try {
            const value: unknown = JSON.parse(data.toString());
            for (const event of parseDeepgram(value, {
              meetingId: input.meetingId,
              offset,
              session,
            }))
              input.onEvent(event);
          } catch {
            input.onEvent({
              type: "connection",
              status: "failed",
              message: "Transcription returned an unreadable response.",
            });
          }
        });
        ws.on("error", () => {
          if (!opened)
            reject(
              new Error(
                "Cannot connect to Deepgram. Check the API key and network.",
              ),
            );
        });
        ws.on("close", () => {
          clearInterval(heartbeat);
          if (!opened)
            reject(
              new Error("Transcription connection closed before startup."),
            );
          if (closing) return;
          if (attempt >= 3) {
            queue = [];
            queueBytes = 0;
            input.onEvent({
              type: "connection",
              status: "failed",
              message:
                "Transcription disconnected after three reconnect attempts. Stop the meeting; your notes are safe.",
            });
            return;
          }
          attempt++;
          input.onEvent({
            type: "connection",
            status: "reconnecting",
            message:
              "Transcription interrupted. Reconnecting; some speech may be missing.",
          });
          reconnectTimer = setTimeout(
            () => {
              if (!closing) void connect().catch(() => {});
            },
            this.retryDelay * 2 ** (attempt - 1),
          );
        });
      });
    try {
      await connect();
    } catch (error) {
      closing = true;
      clearTimeout(reconnectTimer);
      socket!.terminate();
      throw error;
    }
    return {
      send(data) {
        if (closing) return;
        bytesSeen += data.byteLength;
        if (
          socket.readyState === WebSocket.OPEN &&
          socket.bufferedAmount < budget
        ) {
          socket.send(data);
          return;
        }
        if (socket.readyState === WebSocket.OPEN) {
          socket.terminate();
        }
        if (attempt >= 3 && socket.readyState === WebSocket.CLOSED) return;
        queue.push(Buffer.from(data));
        queueBytes += data.byteLength;
        while (queueBytes > budget) {
          queueBytes -= queue.shift()!.byteLength;
          if (!gapReported) {
            gapReported = true;
            input.onEvent({
              type: "connection",
              status: "reconnecting",
              message:
                "Connection is too slow. Audio beyond the five-second memory buffer is discarded; your notes remain safe.",
            });
          }
        }
      },
      async close() {
        closing = true;
        clearTimeout(reconnectTimer);
        clearInterval(heartbeat);
        queue = [];
        queueBytes = 0;
        if (socket.readyState === WebSocket.OPEN) {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              socket.terminate();
              reject(
                new Error(
                  "Transcript finalization timed out. The last few words may be missing.",
                ),
              );
            }, 8000);
            socket.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
            socket.send(JSON.stringify({ type: "CloseStream" }));
          });
        } else socket.terminate();
        input.onEvent({ type: "connection", status: "closed" });
      },
    };
  }
}
