import { mkdir, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, type MeetingRepository } from "../database";
import {
  newMeeting,
  transition,
  type Meeting,
  type Segment,
  type Template,
  type Settings,
} from "../shared";
export class MeetingService {
  private tail: Promise<unknown> = Promise.resolve();
  private authorized = new Set<string>();
  constructor(
    readonly repository: MeetingRepository,
    readonly userId: string,
    private recoveryDir: string,
  ) {}
  async init() {
    await mkdir(this.recoveryDir, { recursive: true, mode: 0o700 });
    for (const m of await this.repository.list()) {
      this.authorized.add(m.id);
      if (m.status === "recording" || m.status === "processing") {
        m.status = "failed";
        m.error =
          "The previous session was interrupted. Your saved notes and transcript are available. Retry intelligence when ready.";
        m.endedAt ??= new Date().toISOString();
        m.durationSeconds = m.startedAt
          ? Math.max(
              0,
              Math.round(
                (Date.parse(m.endedAt) - Date.parse(m.startedAt)) / 1000,
              ),
            )
          : 0;
        await this.repository.save(m);
      }
    }
    await this.recover();
  }
  private async recover() {
    for (const file of await readdir(this.recoveryDir)) {
      if (!file.endsWith(".json")) continue;
      const draft = JSON.parse(
        await readFile(join(this.recoveryDir, file), "utf8"),
      ) as { id: string; content?: string; segment?: Segment };
      if (!this.authorized.has(draft.id)) continue;
      const m = await this.repository.get(draft.id);
      if (draft.segment) {
        if (!m.segments.some((s) => s.id === draft.segment!.id))
          m.segments.push(draft.segment);
      } else if (typeof draft.content === "string") m.notes = draft.content;
      await this.repository.save(m);
      await rm(join(this.recoveryDir, file));
    }
  }
  async recoverPending() {
    return this.serial(() => this.recover());
  }
  serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next;
  }
  async flush() {
    await this.tail;
  }
  async create(title: string, template: Template) {
    return this.serial(async () => {
      const m = newMeeting(this.userId, { title, template });
      await this.repository.save(m);
      this.authorized.add(m.id);
      return m;
    });
  }
  async update(id: string, change: (m: Meeting) => void) {
    return this.serial(async () => {
      const m = await this.repository.get(id);
      change(m);
      m.updatedAt = new Date().toISOString();
      await this.repository.save(m);
      return m;
    });
  }
  async saveNotes(id: string, content: string) {
    return this.serial(async () => {
      // IDs come from this user's loaded/created meetings, even when the database is offline.
      if (!this.authorized.has(id)) throw new Error("Meeting not found");
      const path = join(this.recoveryDir, `${id}.json`);
      await atomicWrite(path, {
        id,
        content,
        savedAt: new Date().toISOString(),
      });
      const m = await this.repository.get(id);
      m.notes = content;
      m.updatedAt = new Date().toISOString();
      await this.repository.save(m);
      await rm(path, { force: true });
    });
  }
  async start(id: string) {
    return this.update(id, (m) => {
      m.status = transition(m.status, "recording");
      m.startedAt = new Date().toISOString();
      m.error = null;
    });
  }
  async stop(id: string) {
    return this.update(id, (m) => {
      m.status = transition(m.status, "processing");
      m.endedAt = new Date().toISOString();
      m.durationSeconds = Math.max(
        0,
        Math.round((Date.parse(m.endedAt) - Date.parse(m.startedAt!)) / 1000),
      );
    });
  }
  async fail(id: string, message: string) {
    return this.update(id, (m) => {
      m.status = "failed";
      m.error = message;
    });
  }
  async segment(id: string, segment: Segment) {
    return this.serial(async () => {
      if (!this.authorized.has(id) || segment.meetingId !== id)
        throw new Error("Invalid segment");
      const path = join(this.recoveryDir, `${id}.segment.${segment.id}.json`);
      await atomicWrite(path, { id, segment });
      const m = await this.repository.get(id);
      if (!m.segments.some((s) => s.id === segment.id))
        m.segments.push(segment);
      await this.repository.save(m);
      await rm(path, { force: true });
      return m;
    });
  }
  async delete(id: string) {
    return this.serial(async () => {
      await this.repository.get(id);
      // Remove recovery before the primary row. Failed primary deletion remains visible and retryable.
      for (const file of await readdir(this.recoveryDir))
        if (file === `${id}.json` || file.startsWith(`${id}.segment.`))
          await rm(join(this.recoveryDir, file), { force: true });
      await this.repository.delete(id);
      this.authorized.delete(id);
    });
  }
  async deleteAll() {
    for (const m of await this.repository.list()) await this.delete(m.id);
  }
  async retain(settings: Settings) {
    if (settings.transcriptRetentionDays === null) return;
    const cutoff = Date.now() - settings.transcriptRetentionDays * 86400000;
    for (const m of await this.repository.list()) {
      if (
        m.endedAt &&
        Date.parse(m.endedAt) < cutoff &&
        m.status !== "recording" &&
        m.status !== "processing"
      ) {
        await this.update(m.id, (current) => {
          current.segments = [];
          current.actions = current.actions.map((a) => ({
            ...a,
            evidenceSegmentIds: [],
          }));
          current.chat = current.chat.map((c) => ({
            ...c,
            evidenceSegmentIds: [],
          }));
          if (current.summary) {
            const x = current.summary.extraction;
            for (const item of [
              ...x.decisions,
              ...x.actionItems,
              ...x.importantFacts,
            ])
              item.evidenceSegmentIds = [];
          }
        });
      }
    }
  }
}
