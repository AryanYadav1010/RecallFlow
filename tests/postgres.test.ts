import { it, expect } from "vitest";
import { PrismaClient } from "../packages/database/generated";
import { PostgresRepository } from "../packages/database/postgres";
import { newMeeting } from "../packages/shared";
it.skipIf(!process.env.TEST_DATABASE_URL)(
  "PostgreSQL persists every entity, scopes search, and cascades complete deletion",
  async () => {
    const db = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    });
    const userId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    try {
      const repo = new PostgresRepository(db, userId);
      await repo.init();
      const m = newMeeting(userId, {
        title: "Integration launch review",
        template: "general",
      });
      const segment = {
        id: crypto.randomUUID(),
        meetingId: m.id,
        speaker: "Speaker",
        text: "Alex will send the launch plan by Friday.",
        startTimeMs: 0,
        endTimeMs: 2000,
        confidence: 0.9,
        createdAt: m.createdAt,
      };
      m.notes = "Sacred human notebook";
      m.segments = [segment];
      m.summary = {
        overview: "Launch plan",
        detailedNotes: "Prepare launch",
        suggestedFollowUp: "Please confirm.",
        createdAt: m.createdAt,
        extraction: {
          topics: [{ name: "Launch", summary: "Plan" }],
          decisions: [],
          actionItems: [
            {
              description: "Send launch plan",
              owner: "Alex",
              dueDate: "Friday",
              evidenceSegmentIds: [segment.id],
            },
          ],
          questions: [],
          risks: [],
          importantFacts: [],
          participants: ["Alex"],
        },
      };
      m.actions = [
        {
          id: crypto.randomUUID(),
          description: "Send launch plan",
          owner: "Alex",
          dueDate: "Friday",
          status: "open",
          evidenceSegmentIds: [segment.id],
        },
      ];
      m.chat = [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Alex will send the plan.",
          kind: "explicit",
          evidenceSegmentIds: [segment.id],
          createdAt: m.createdAt,
        },
      ];
      await repo.save(m);
      const restored = await repo.get(m.id);
      expect(restored.notes).toBe(m.notes);
      expect(restored.segments).toHaveLength(1);
      expect(restored.actions[0].owner).toBe("Alex");
      expect(restored.chat).toHaveLength(1);
      expect((await repo.list("notebook")).map((m) => m.id)).toContain(m.id);
      expect((await repo.list("Friday")).map((m) => m.id)).toContain(m.id);
      const other = new PostgresRepository(db, otherId);
      await other.init();
      expect(await other.list("launch")).toEqual([]);
      await expect(other.get(m.id)).rejects.toThrow("Meeting not found");
      await repo.delete(m.id);
      expect(
        await db.transcriptSegment.count({ where: { meetingId: m.id } }),
      ).toBe(0);
      expect(await db.rawNote.count({ where: { meetingId: m.id } })).toBe(0);
      expect(
        await db.meetingSummary.count({ where: { meetingId: m.id } }),
      ).toBe(0);
      expect(await db.actionItem.count({ where: { meetingId: m.id } })).toBe(0);
      expect(await db.participant.count({ where: { meetingId: m.id } })).toBe(
        0,
      );
      expect(await db.chatMessage.count({ where: { meetingId: m.id } })).toBe(
        0,
      );
    } finally {
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
      await db.$disconnect();
    }
  },
);
