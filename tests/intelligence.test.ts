import { it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MockAIProvider,
  groundExtraction,
  normalize,
  RemoteAIProvider,
} from "../packages/ai";
import { LocalRepository } from "../packages/database";
import { MeetingService } from "../packages/core/service";
import { IntelligenceService } from "../packages/core/intelligence";
import { newMeeting } from "../packages/shared";
it("grounds action owners, dates and source IDs without fabricating evidence", async () => {
  const m = newMeeting("u", { title: "Test", template: "general" });
  m.segments = [
    {
      id: "source",
      meetingId: m.id,
      text: "Alex will prepare the draft by Friday.",
      speaker: "Speaker 1",
      startTimeMs: 0,
      endTimeMs: 1000,
      confidence: 1,
      createdAt: m.createdAt,
    },
  ];
  const context = normalize(m);
  const result = await new MockAIProvider().extract(context);
  expect(result.actionItems[0]).toMatchObject({
    owner: "Alex",
    dueDate: "Friday",
    evidenceSegmentIds: ["source"],
  });
  result.actionItems[0].owner = "James";
  result.actionItems[0].dueDate = "2028-01-01";
  result.decisions.push({ text: "Invented", evidenceSegmentIds: ["unknown"] });
  const grounded = groundExtraction(result, context);
  expect(grounded.actionItems[0].owner).toBeNull();
  expect(grounded.actionItems[0].dueDate).toBeNull();
  expect(grounded.decisions).toEqual([]);
});
it("retries presentation without retranscribing or extracting again and preserves personal notes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recallflow-ai-"));
  try {
    const repo = new LocalRepository(join(dir, "meetings"), "u");
    await repo.init();
    const service = new MeetingService(repo, "u", join(dir, "recovery"));
    await service.init();
    const m = await service.create("Review", "general");
    await service.saveNotes(m.id, "Human priority");
    await service.start(m.id);
    await service.stop(m.id);
    const ai = new MockAIProvider();
    const extract = vi.spyOn(ai, "extract");
    const present = vi.spyOn(ai, "present");
    present.mockRejectedValueOnce(new Error("offline"));
    const intelligence = new IntelligenceService(service, ai);
    await expect(intelligence.generate(m.id)).rejects.toThrow("offline");
    expect((await repo.get(m.id)).status).toBe("failed");
    const completed = await intelligence.generate(m.id);
    expect(completed.status).toBe("complete");
    expect(completed.notes).toBe("Human priority");
    expect(extract).toHaveBeenCalledTimes(1);
    expect(completed.summary?.extraction).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("validates provider JSON and does not accept incomplete structured output", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ actionItems: [] }) },
          },
        ],
      }),
      { status: 200 },
    ),
  );
  const ai = new RemoteAIProvider(
    { provider: "openai", key: "test", model: "test" },
    request,
  );
  await expect(
    ai.extract({
      title: "Meeting",
      date: "today",
      transcript: [],
      notes: "",
      template: "general",
    }),
  ).rejects.toThrow();
});
