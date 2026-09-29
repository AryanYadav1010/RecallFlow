import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalRepository } from "../packages/database";
import { MeetingService } from "../packages/core/service";
import { IntelligenceService } from "../packages/core/intelligence";
import {
  MeetingSession,
  mainWindowCloseAction,
} from "../packages/core/session";
import { MockAIProvider } from "../packages/ai";
import type { TranscriptionProvider } from "../packages/transcription";
import type { SessionState } from "../packages/shared";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recallflow-session-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function setup(options: { releaseTimeoutMs?: number } = {}) {
  const repo = new LocalRepository(join(dir, "meetings"), "u");
  await repo.init();
  const service = new MeetingService(repo, "u", join(dir, "recovery"));
  await service.init();
  const sent: Buffer[] = [];
  const close = vi.fn(async () => {});
  const transcription: TranscriptionProvider = {
    connect: async () => ({ send: (data) => sent.push(data), close }),
  };
  const ai = new MockAIProvider();
  const intelligence = new IntelligenceService(service, ai);
  const generate = vi.spyOn(intelligence, "generate");
  const states: SessionState[] = [];
  const releaseCapture = vi.fn();
  const session = new MeetingSession({
    service,
    transcription: () => transcription,
    intelligence: () => intelligence,
    onTranscript: () => {},
    onState: (state) => states.push(state),
    releaseCapture,
    releaseTimeoutMs: options.releaseTimeoutMs ?? 60000,
  });
  return {
    repo,
    service,
    session,
    sent,
    close,
    generate,
    states,
    releaseCapture,
  };
}
it("floating window receives recording state", async () => {
  const { service, session, states } = await setup();
  const m = await service.create("Weekly sync", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  session.source(m.id, "microphone", true);
  expect(states.at(-1)).toMatchObject({
    phase: "recording",
    meetingId: m.id,
    title: "Weekly sync",
    microphone: "connected",
    systemAudio: "off",
  });
  expect(states.at(-1)?.startedAt).toBeTruthy();
  await session.stop(m.id);
  await session.processing;
});
it("meeting remains active when the main window hides", async () => {
  const { repo, service, session, sent } = await setup();
  const m = await service.create("Hidden window", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  // Closing the main window while recording hides it instead of closing.
  expect(mainWindowCloseAction(session.state, false)).toBe("hide");
  session.audio(m.id, Buffer.alloc(320));
  session.audio(m.id, Buffer.alloc(320));
  expect(sent).toHaveLength(2);
  expect(session.busy).toBe(true);
  expect((await repo.get(m.id)).status).toBe("recording");
  // Quitting (after confirmation) and idle windows close normally.
  expect(mainWindowCloseAction(session.state, true)).toBe("close");
  await session.stop(m.id);
  await session.processing;
  expect(mainWindowCloseAction(session.state, false)).toBe("close");
});
it("Stop from the floating window stops exactly one meeting", async () => {
  const { repo, service, session, close, generate, states, releaseCapture } =
    await setup();
  const other = await service.create("Not started", "general");
  const m = await service.create("Live", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  const stopSpy = vi.spyOn(service, "stop");
  // Double click in the floating window, then tray Stop as well.
  expect(session.requestStop()).toBe(true);
  expect(session.requestStop()).toBe(false);
  expect(session.requestStop()).toBe(false);
  expect(releaseCapture).toHaveBeenCalledTimes(1);
  expect(releaseCapture).toHaveBeenCalledWith(m.id);
  expect(session.state.phase).toBe("stopping");
  // The capture window releases the microphone and calls stop, possibly twice.
  const [a, b] = await Promise.all([session.stop(m.id), session.stop(m.id)]);
  await session.processing;
  expect(a.id).toBe(m.id);
  expect(b.id).toBe(m.id);
  expect(close).toHaveBeenCalledTimes(1);
  expect(stopSpy).toHaveBeenCalledTimes(1);
  expect(generate).toHaveBeenCalledTimes(1);
  expect((await repo.get(m.id)).status).toBe("complete");
  expect((await repo.get(other.id)).status).toBe("draft");
  expect(states.map((s) => s.phase)).toEqual(
    expect.arrayContaining(["recording", "stopping", "processing", "ready"]),
  );
  expect(session.busy).toBe(false);
});
it("stops without the capture window if it does not answer", async () => {
  const { repo, service, session, close } = await setup({
    releaseTimeoutMs: 20,
  });
  const m = await service.create("Unresponsive renderer", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  session.requestStop();
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(session.state.phase).toBe("ready"));
  expect((await repo.get(m.id)).status).toBe("complete");
});
it("quitting fails the meeting visibly instead of generating notes", async () => {
  const { repo, service, session, generate } = await setup();
  const m = await service.create("Quit", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  await session.stop(m.id, "Recording stopped because RecallFlow quit.");
  expect(generate).not.toHaveBeenCalled();
  expect(await repo.get(m.id)).toMatchObject({
    status: "failed",
    error: "Recording stopped because RecallFlow quit.",
  });
  expect(session.state.phase).toBe("idle");
});
it("dismissing the floating status never ends a recording", async () => {
  const { service, session } = await setup();
  const m = await service.create("Keep going", "general");
  await session.start({ id: m.id, sampleRate: 16000, systemAudio: false });
  session.dismiss();
  expect(session.state.phase).toBe("recording");
  await session.stop(m.id);
  await session.processing;
  session.dismiss();
  expect(session.state.phase).toBe("idle");
});
