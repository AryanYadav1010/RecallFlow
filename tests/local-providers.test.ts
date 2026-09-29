import { it, expect, vi, describe } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import {
  WhisperCppProvider,
  resampleTo16k,
  cleanWhisperText,
} from "../packages/transcription/whisper";
import { OllamaAIProvider } from "../packages/ai/ollama";
import { MockAIProvider, RemoteAIProvider } from "../packages/ai";
import { DeepgramProvider } from "../packages/transcription";
import { EnvSchema, resolveConfig } from "../packages/core/config";
import {
  createProviders,
  localMode,
  providerStatuses,
} from "../packages/core/providers";
import { LocalRepository } from "../packages/database";
import { MeetingService } from "../packages/core/service";
import { IntelligenceService } from "../packages/core/intelligence";
import { MeetingSession } from "../packages/core/session";
import { UserFacingError, type TranscriptionEvent } from "../packages/shared";
const context = {
  title: "Sync",
  date: "2026-09-29",
  transcript: [{ id: "s1", speaker: "Speaker", text: "Alex will ship it." }],
  notes: "",
  template: "general" as const,
};
const validExtraction = {
  topics: [],
  decisions: [],
  actionItems: [],
  questions: [],
  risks: [],
  importantFacts: [],
  participants: [],
};
const ollamaReply = (content: string) =>
  new Response(JSON.stringify({ message: { role: "assistant", content } }));
const config = (values: Record<string, string>) =>
  resolveConfig(EnvSchema.parse(values), {
    whisperReady: false,
    ollamaReachable: false,
  });
describe("Local Whisper", () => {
  it("reports a missing model clearly and never starts the server", async () => {
    const launch = vi.fn();
    const provider = new WhisperCppProvider({
      model: "base",
      modelPath: "/nonexistent/ggml-base.en.bin",
      serverPath: "/opt/homebrew/bin/whisper-server",
      launch,
    });
    const error = await provider
      .connect({ meetingId: "m", sampleRate: 16000, onEvent: () => {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toContain("/nonexistent/ggml-base.en.bin");
    expect((error as Error).message).toContain("Personal Zero-Cost Setup");
    expect(launch).not.toHaveBeenCalled();
  });
  it("reports a missing whisper-server binary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recallflow-whisper-"));
    try {
      await writeFile(join(dir, "model.bin"), "x");
      await expect(
        new WhisperCppProvider({
          model: "tiny",
          modelPath: join(dir, "model.bin"),
          serverPath: null,
        }).preflight(),
      ).rejects.toThrow("brew install whisper-cpp");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("leaves the meeting as a draft when the model is missing, without falling back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recallflow-whisper-"));
    try {
      const repo = new LocalRepository(join(dir, "meetings"), "u");
      await repo.init();
      const service = new MeetingService(repo, "u", join(dir, "recovery"));
      await service.init();
      const m = await service.create("Private", "general");
      const session = new MeetingSession({
        service,
        transcription: () =>
          new WhisperCppProvider({
            model: "base",
            modelPath: join(dir, "missing.bin"),
            serverPath: "/usr/bin/true",
          }),
        intelligence: () =>
          new IntelligenceService(service, new MockAIProvider()),
        onTranscript: () => {},
        onState: () => {},
        releaseCapture: () => {},
      });
      await expect(
        session.start({ id: m.id, sampleRate: 16000, systemAudio: false }),
      ).rejects.toThrow("model is missing");
      expect((await repo.get(m.id)).status).toBe("draft");
      expect(session.state.phase).toBe("idle");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("chunks speech at pauses, skips silence and keeps audio in memory", async () => {
    const requests: Buffer[] = [];
    const server = createServer((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (d: Buffer) => body.push(d));
      req.on("end", () => {
        requests.push(Buffer.concat(body));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ text: " Hello there.\n [BLANK_AUDIO]\n" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = await mkdtemp(join(tmpdir(), "recallflow-whisper-"));
    try {
      await writeFile(join(dir, "model.bin"), "x");
      const stop = vi.fn(async () => {});
      const events: TranscriptionEvent[] = [];
      const session = await new WhisperCppProvider({
        model: "tiny",
        modelPath: join(dir, "model.bin"),
        serverPath: "/usr/bin/true",
        launch: async () => ({ url, stop, exited: new Promise(() => {}) }),
      }).connect({
        meetingId: "m",
        sampleRate: 48000,
        onEvent: (e) => events.push(e),
      });
      const chunk = (loud: boolean) => {
        const pcm = new Int16Array(4800); // 100 ms at 48 kHz, like the worklet
        if (loud)
          for (let i = 0; i < pcm.length; i++)
            pcm[i] = Math.round(8000 * Math.sin(i / 5));
        return Buffer.from(pcm.buffer);
      };
      for (let i = 0; i < 20; i++) session.send(chunk(false)); // 2 s silence
      for (let i = 0; i < 45; i++) session.send(chunk(true)); // 4.5 s speech
      for (let i = 0; i < 6; i++) session.send(chunk(false)); // pause → cut
      for (let i = 0; i < 20; i++) session.send(chunk(false)); // trailing silence
      await session.close();
      expect(requests).toHaveLength(1);
      expect(requests[0].includes(Buffer.from("WAVE"))).toBe(true);
      const finals = events.filter((e) => e.type === "final");
      expect(finals).toHaveLength(1);
      expect(finals[0].type === "final" && finals[0].segment).toMatchObject({
        text: "Hello there.",
        startTimeMs: 0,
        endTimeMs: 7000,
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: "connection", status: "closed" });
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("resamples to 16 kHz and strips non-speech markers", () => {
    expect(resampleTo16k(new Int16Array(4800), 48000)).toHaveLength(1600);
    expect(resampleTo16k(new Int16Array(4410), 44100)).toHaveLength(1600);
    expect(cleanWhisperText(" [BLANK_AUDIO]\n")).toBe("");
    expect(cleanWhisperText(" (music)\n We shipped it. [Applause]")).toBe(
      "We shipped it.",
    );
  });
});
describe("Ollama", () => {
  const provider = (request: typeof fetch) =>
    new OllamaAIProvider(
      { host: "http://127.0.0.1:11434", model: "qwen3:4b", maxContext: 32768 },
      request,
    );
  it("reports Ollama being unavailable", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    await expect(provider(request).extract(context)).rejects.toThrow(
      "Ollama is not reachable at http://127.0.0.1:11434",
    );
  });
  it("explains how to install a missing model", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(provider(request).extract(context)).rejects.toThrow(
      "ollama pull qwen3:4b",
    );
  });
  it("repairs malformed structured output once", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ollamaReply('{"topics": "oops"'))
      .mockResolvedValueOnce(
        ollamaReply(`<think>ok</think>${JSON.stringify(validExtraction)}`),
      );
    await expect(provider(request).extract(context)).resolves.toEqual(
      validExtraction,
    );
    expect(request).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(request.mock.calls[1][1]?.body)) as {
      messages: { role: string; content: string }[];
      format: unknown;
      think: boolean;
    };
    expect(retry.messages.at(-1)?.content).toContain("invalid");
    expect(retry.format).toBeTruthy();
    expect(retry.think).toBe(false);
  });
  it("fails cleanly after one repair and never fabricates notes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recallflow-ollama-"));
    try {
      const repo = new LocalRepository(join(dir, "meetings"), "u");
      await repo.init();
      const service = new MeetingService(repo, "u", join(dir, "recovery"));
      await service.init();
      const m = await service.create("Review", "general");
      await service.saveNotes(m.id, "My own notes");
      await service.start(m.id);
      await service.stop(m.id);
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          ollamaReply(JSON.stringify({ actionItems: [{ description: 1 }] })),
        );
      const intelligence = new IntelligenceService(service, provider(request));
      await expect(intelligence.generate(m.id)).rejects.toThrow(
        "did not match the required structure",
      );
      expect(request).toHaveBeenCalledTimes(2);
      const failed = await repo.get(m.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatch(/^AI generation failed: The local model/);
      expect(failed.summary).toBeNull();
      expect(failed.actions).toEqual([]);
      expect(failed.notes).toBe("My own notes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses meetings larger than the local context instead of truncating", async () => {
    const request = vi.fn<typeof fetch>();
    const huge = {
      ...context,
      transcript: [{ id: "s1", speaker: "Speaker", text: "x".repeat(200000) }],
    };
    await expect(provider(request).extract(huge)).rejects.toThrow(
      "OLLAMA_NUM_CTX",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
describe("provider selection", () => {
  it("switches providers without changing the meeting system", () => {
    const pick = (values: Record<string, string>) =>
      createProviders(config(values), "/opt/homebrew/bin/whisper-server");
    expect(
      pick({ TRANSCRIPTION_PROVIDER: "whisper", AI_PROVIDER: "ollama" }),
    ).toMatchObject({
      transcription: expect.any(WhisperCppProvider),
      ai: expect.any(OllamaAIProvider),
    });
    expect(
      pick({
        TRANSCRIPTION_PROVIDER: "deepgram",
        DEEPGRAM_API_KEY: "k",
        AI_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
      }),
    ).toMatchObject({
      transcription: expect.any(DeepgramProvider),
      ai: expect.any(RemoteAIProvider),
    });
    expect(() =>
      config({ TRANSCRIPTION_PROVIDER: "mock", AI_PROVIDER: "openai" }),
    ).toThrow("OPENAI_API_KEY is required");
  });
  it("prefers local providers only when they are actually available", () => {
    const raw = EnvSchema.parse({
      TRANSCRIPTION_PROVIDER: "",
      AI_PROVIDER: "",
    });
    expect(
      resolveConfig(raw, { whisperReady: true, ollamaReachable: true }),
    ).toMatchObject({
      TRANSCRIPTION_PROVIDER: "whisper",
      AI_PROVIDER: "ollama",
    });
    expect(
      resolveConfig(raw, { whisperReady: false, ollamaReachable: false }),
    ).toMatchObject({ TRANSCRIPTION_PROVIDER: "mock", AI_PROVIDER: "mock" });
    // An explicit choice is never overridden by detection.
    expect(
      resolveConfig(
        EnvSchema.parse({
          AI_PROVIDER: "mock",
          TRANSCRIPTION_PROVIDER: "mock",
        }),
        { whisperReady: true, ollamaReachable: true },
      ),
    ).toMatchObject({ TRANSCRIPTION_PROVIDER: "mock", AI_PROVIDER: "mock" });
  });
  it("calculates Local Mode status", () => {
    expect(
      localMode(
        config({ TRANSCRIPTION_PROVIDER: "whisper", AI_PROVIDER: "ollama" }),
      ),
    ).toEqual({ active: true, caveats: [] });
    expect(
      localMode(
        config({
          TRANSCRIPTION_PROVIDER: "whisper",
          AI_PROVIDER: "openai",
          OPENAI_API_KEY: "k",
        }),
      ).active,
    ).toBe(false);
    const remoteOllama = localMode(
      config({
        TRANSCRIPTION_PROVIDER: "whisper",
        AI_PROVIDER: "ollama",
        OLLAMA_HOST: "http://gpu-box.lan:11434",
      }),
    );
    expect(remoteOllama.active).toBe(false);
    expect(remoteOllama.caveats[0]).toContain("gpu-box.lan");
    const remoteDatabase = localMode(
      config({
        TRANSCRIPTION_PROVIDER: "whisper",
        AI_PROVIDER: "ollama",
        APP_MODE: "database",
        DATABASE_URL: "postgresql://u:p@db.example.com:5432/app",
      }),
    );
    expect(remoteDatabase.active).toBe(true);
    expect(remoteDatabase.caveats).toHaveLength(1);
  });
  it("shows readiness for every provider", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] })),
      );
    const statuses = await providerStatuses(
      config({
        TRANSCRIPTION_PROVIDER: "whisper",
        AI_PROVIDER: "ollama",
        WHISPER_MODEL_PATH: "/nonexistent/model.bin",
      }),
      "/opt/homebrew/bin/whisper-server",
      request,
    );
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s]));
    expect(byId.ollama).toMatchObject({
      ready: true,
      detail: "Connected — qwen3:4b",
    });
    expect(byId.whisper).toMatchObject({ ready: false, local: true });
    expect(byId.whisper.detail).toContain("Model missing");
    expect(byId.deepgram).toMatchObject({
      ready: false,
      detail: "API key missing",
    });
    expect(byId.openai.detail).toBe("API key missing");
  });
});
