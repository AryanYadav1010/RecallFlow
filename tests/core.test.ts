import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRepository, createMeeting } from "../packages/database";
import { transition, ExtractionSchema } from "../packages/shared";
describe("meeting foundation", () => {
  it("creates, persists, scopes and deletes a meeting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recallflow-"));
    try {
      const repo = new LocalRepository(dir, "user-a");
      await repo.init();
      const m = createMeeting("user-a", "Product review");
      await repo.save(m);
      expect((await repo.get(m.id)).title).toBe("Product review");
      expect(await new LocalRepository(dir, "user-b").list()).toEqual([]);
      await expect(
        new LocalRepository(dir, "user-b").get(m.id),
      ).rejects.toThrow();
      await repo.delete(m.id);
      expect(await repo.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("enforces lifecycle transitions", () => {
    expect(transition("draft", "recording")).toBe("recording");
    expect(() => transition("draft", "complete")).toThrow();
  });
  it("rejects malformed extraction", () => {
    expect(
      ExtractionSchema.safeParse({ actionItems: [{ description: "Ship it" }] })
        .success,
    ).toBe(false);
  });
});
