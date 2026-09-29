import { it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalRepository } from "../packages/database";
import { MeetingService } from "../packages/core/service";
it("serializes note saves and transcript updates, recovers interrupted recordings, deletes associated data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recallflow-notes-"));
  try {
    const repo = new LocalRepository(join(dir, "meetings"), "user");
    await repo.init();
    const service = new MeetingService(repo, "user", join(dir, "recovery"));
    await service.init();
    const m = await service.create("Design", "general");
    await service.start(m.id);
    await Promise.all([
      service.saveNotes(m.id, "Human priority"),
      service.segment(m.id, {
        id: crypto.randomUUID(),
        meetingId: m.id,
        speaker: "Speaker 1",
        text: "A final sentence",
        startTimeMs: 0,
        endTimeMs: 1000,
        confidence: 1,
        createdAt: new Date().toISOString(),
      }),
    ]);
    expect((await repo.get(m.id)).notes).toBe("Human priority");
    expect((await repo.get(m.id)).segments).toHaveLength(1);
    await new MeetingService(repo, "user", join(dir, "recovery")).init();
    expect((await repo.get(m.id)).status).toBe("failed");
    await service.delete(m.id);
    expect(await repo.list()).toHaveLength(0);
    expect(await readdir(join(dir, "recovery"))).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("preserves a recovery journal if the repository write fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recallflow-recovery-"));
  try {
    const repo = new LocalRepository(join(dir, "meetings"), "user");
    await repo.init();
    const service = new MeetingService(repo, "user", join(dir, "recovery"));
    await service.init();
    const m = await service.create("Offline", "general");
    const save = repo.save.bind(repo);
    repo.save = async () => {
      throw new Error("offline");
    };
    await expect(service.saveNotes(m.id, "Do not lose this")).rejects.toThrow(
      "offline",
    );
    expect(await readdir(join(dir, "recovery"))).toHaveLength(1);
    repo.save = save;
    await service.init();
    expect((await repo.get(m.id)).notes).toBe("Do not lose this");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("journals notes and final transcript even when repository reads fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recallflow-offline-"));
  try {
    const repo = new LocalRepository(join(dir, "meetings"), "u");
    await repo.init();
    const service = new MeetingService(repo, "u", join(dir, "recovery"));
    await service.init();
    const m = await service.create("Offline read", "general");
    const get = repo.get.bind(repo);
    repo.get = async () => {
      throw new Error("offline");
    };
    await expect(service.saveNotes(m.id, "Still safe")).rejects.toThrow();
    await expect(
      service.segment(m.id, {
        id: crypto.randomUUID(),
        meetingId: m.id,
        speaker: "Speaker",
        text: "Final words",
        startTimeMs: 0,
        endTimeMs: 1000,
        confidence: 1,
        createdAt: m.createdAt,
      }),
    ).rejects.toThrow();
    expect(await readdir(join(dir, "recovery"))).toHaveLength(2);
    repo.get = get;
    await service.recoverPending();
    const restored = await repo.get(m.id);
    expect(restored.notes).toBe("Still safe");
    expect(restored.segments[0].text).toBe("Final words");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("retains human notes while expiring original transcript and structured citations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recallflow-retention-"));
  try {
    const repo = new LocalRepository(join(dir, "meetings"), "u");
    await repo.init();
    const service = new MeetingService(repo, "u", join(dir, "recovery"));
    await service.init();
    const m = await service.create("Old meeting", "general");
    await service.saveNotes(m.id, "Keep my notes");
    await service.segment(m.id, {
      id: crypto.randomUUID(),
      meetingId: m.id,
      speaker: "Speaker",
      text: "Original speech",
      startTimeMs: 0,
      endTimeMs: 1000,
      confidence: 1,
      createdAt: m.createdAt,
    });
    await service.update(m.id, (current) => {
      current.endedAt = "2020-01-01T00:00:00.000Z";
      current.status = "complete";
    });
    await service.retain({
      defaultTemplate: "general",
      transcriptRetentionDays: 7,
      compactOnStart: true,
    });
    expect((await repo.get(m.id)).segments).toEqual([]);
    expect((await repo.get(m.id)).notes).toBe("Keep my notes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
