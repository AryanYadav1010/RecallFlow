import {
  UserFacingError,
  idleSession,
  type Meeting,
  type SessionState,
  type TranscriptionEvent,
} from "../shared";
import type {
  TranscriptionProvider,
  TranscriptionSession,
} from "../transcription";
import type { IntelligenceService } from "./intelligence";
import type { MeetingService } from "./service";
type Active = {
  id: string;
  session: TranscriptionSession | null;
  connecting: Promise<TranscriptionSession> | null;
  blocker?: number;
  lastAudio: number;
  stopRequested: boolean;
  /** When set, the meeting is failed with this reason instead of processed. */
  failWith?: string;
};
export type SessionDeps = {
  service: MeetingService;
  transcription: () => TranscriptionProvider;
  intelligence: () => IntelligenceService;
  onTranscript: (event: TranscriptionEvent) => void;
  onState: (state: SessionState) => void;
  /** Asks the window that owns the microphone to release it and call stop(). */
  releaseCapture: (meetingId: string) => void;
  keepAwake?: { start(): number; stop(id: number): void };
  releaseTimeoutMs?: number;
  silenceTimeoutMs?: number;
};
/**
 * Owns the single live meeting: its transcription session, lifecycle and the
 * state every window renders. Windows never own recording. They send
 * commands here, so hiding or closing one cannot end a meeting.
 */
export class MeetingSession {
  state: SessionState = idleSession;
  /** Settles when post-meeting note generation finishes. */
  processing: Promise<void> = Promise.resolve();
  private active: Active | null = null;
  private ending: { id: string; promise: Promise<Meeting> } | null = null;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  constructor(private deps: SessionDeps) {}
  private set(patch: Partial<SessionState>) {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }
  /** True while recording or while capture is being released. */
  get busy() {
    return !!this.active || !!this.ending;
  }
  get recordingId() {
    return this.active?.id ?? null;
  }
  async start(input: { id: string; sampleRate: number; systemAudio: boolean }) {
    if (this.busy) throw new UserFacingError("A meeting is already active.");
    const provider = this.deps.transcription();
    await provider.preflight?.();
    const meeting = await this.deps.service.start(input.id);
    const current: Active = {
      id: input.id,
      session: null,
      connecting: null,
      blocker: this.deps.keepAwake?.start(),
      lastAudio: Date.now(),
      stopRequested: false,
    };
    this.active = current;
    this.set({
      ...idleSession,
      phase: "recording",
      meetingId: meeting.id,
      title: meeting.title,
      startedAt: meeting.startedAt,
      microphone: "waiting",
      systemAudio: input.systemAudio ? "waiting" : "off",
      transcription: "connecting",
    });
    try {
      current.connecting = provider.connect({
        meetingId: input.id,
        sampleRate: input.sampleRate,
        onEvent: (event) => this.onEvent(input.id, event),
      });
      current.session = await current.connecting;
    } catch (error) {
      if (this.active === current) {
        this.stopTimers(current);
        this.active = null;
        await this.deps.service.fail(
          input.id,
          error instanceof UserFacingError
            ? error.message
            : "Transcription could not connect. Check provider settings and network.",
        );
        this.set(idleSession);
      }
      throw error;
    }
    this.watchdog = setInterval(() => {
      const a = this.active;
      if (
        a?.session &&
        Date.now() - a.lastAudio > (this.deps.silenceTimeoutMs ?? 30000)
      ) {
        this.deps.onTranscript({
          type: "connection",
          status: "failed",
          message:
            "No audio has arrived for 30 seconds. Capture has been stopped.",
        });
        this.requestStop();
      }
    }, 5000);
  }
  private onEvent(id: string, event: TranscriptionEvent) {
    if (event.type === "final") {
      void this.deps.service
        .segment(id, event.segment)
        .then(() => this.deps.onTranscript(event))
        .catch(() =>
          this.deps.onTranscript({
            type: "connection",
            status: "failed",
            message:
              "Could not save transcript. Your notes have separate recovery.",
          }),
        );
      return;
    }
    this.deps.onTranscript(event);
    if (event.type !== "connection" || this.active?.id !== id) return;
    if (event.status !== "closed") this.set({ transcription: event.status });
    if (event.status === "reconnecting" || event.status === "failed") {
      this.set({ message: event.message ?? "Transcription interrupted" });
      void this.deps.service
        .update(id, (m) => {
          m.error = event.message ?? "Transcription interrupted";
        })
        .catch(() => {});
    }
  }
  audio(id: string, data: Buffer) {
    const a = this.active;
    if (!a?.session || a.id !== id) return;
    a.lastAudio = Date.now();
    a.session.send(data);
  }
  source(id: string, source: "microphone" | "system", connected: boolean) {
    if (this.active?.id !== id) return;
    this.set(
      source === "microphone"
        ? { microphone: connected ? "connected" : "disconnected" }
        : { systemAudio: connected ? "connected" : "unavailable" },
    );
  }
  /**
   * Stop requested from anywhere (floating window, tray, quit). The capture
   * window is asked to release the microphone and then calls stop(); if it
   * cannot answer, the meeting is stopped without it.
   */
  requestStop(options: { failWith?: string } = {}) {
    const current = this.active;
    if (!current) return false;
    if (options.failWith) current.failWith = options.failWith;
    if (current.stopRequested) return false;
    current.stopRequested = true;
    this.set({ phase: "stopping" });
    this.deps.releaseCapture(current.id);
    this.releaseTimer = setTimeout(
      () => void this.stop(current.id).catch(() => {}),
      this.deps.releaseTimeoutMs ?? 5000,
    );
    return true;
  }
  /** Ends capture exactly once, however many callers ask. */
  stop(id: string, failWith?: string): Promise<Meeting> {
    if (this.ending?.id === id) return this.ending.promise;
    const current = this.active;
    if (current?.id !== id) return this.stopInactive(id);
    if (failWith) current.failWith = failWith;
    this.stopTimers(current);
    this.active = null;
    const promise = this.end(current).finally(() => {
      this.ending = null;
    });
    this.ending = { id, promise };
    return promise;
  }
  private async stopInactive(id: string) {
    const m = await this.deps.service.repository.get(id);
    return m.status === "recording" ? this.deps.service.stop(id) : m;
  }
  private stopTimers(current: Active) {
    clearTimeout(this.releaseTimer);
    clearInterval(this.watchdog);
    if (current.blocker !== undefined)
      this.deps.keepAwake?.stop(current.blocker);
  }
  private async end(current: Active): Promise<Meeting> {
    this.set({ phase: "stopping", microphone: "off", systemAudio: "off" });
    let warning: string | undefined;
    try {
      const session =
        current.session ?? (await current.connecting?.catch(() => null));
      await session?.close();
    } catch {
      warning =
        "Transcript finalization failed. The last few words may be missing.";
    }
    const { service } = this.deps;
    await service.flush();
    if ((await service.repository.get(current.id)).status === "recording")
      await service.stop(current.id);
    if (warning)
      await service.update(current.id, (m) => {
        m.error = warning!;
      });
    this.set({ transcription: "off" });
    if (current.failWith) {
      await service.fail(current.id, current.failWith);
      this.set(idleSession);
    } else
      this.processing = this.generate(current.id).then(
        () => {},
        () => {},
      );
    return service.repository.get(current.id);
  }
  /** After Stop: transcript + notes → AI extraction → final notes. */
  async generate(id: string): Promise<Meeting> {
    if (this.state.meetingId === id)
      this.set({ phase: "processing", message: null });
    try {
      const m = await this.deps.intelligence().generate(id);
      if (this.state.meetingId === id) this.set({ phase: "ready" });
      return m;
    } catch (error) {
      if (this.state.meetingId === id)
        this.set({
          phase: "failed",
          message:
            error instanceof UserFacingError
              ? error.message
              : "Notes could not be generated. Your transcript and notes are saved.",
        });
      throw error;
    }
  }
  /** Hides the post-meeting status. Never ends a recording. */
  dismiss() {
    if (!this.busy) this.set(idleSession);
  }
}
/** Closing the main window during a meeting hides it; capture lives there. */
export function mainWindowCloseAction(
  state: SessionState,
  quitting: boolean,
): "hide" | "close" {
  return !quitting &&
    (state.phase === "recording" || state.phase === "stopping")
    ? "hide"
    : "close";
}
