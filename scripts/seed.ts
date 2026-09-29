import "dotenv/config";
import { PrismaClient } from "../packages/database/generated";
import { PostgresRepository } from "../packages/database/postgres";
import { createMeeting } from "../packages/database";
import { MockAIProvider, normalize } from "../packages/ai";
import { MOCK_LINES } from "../packages/transcription";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
if (!process.env.DATABASE_URL)
  throw new Error(
    "Seed requires DATABASE_URL and an initialized desktop identity. Launch the app once first.",
  );
const root =
  process.env.RECALLFLOW_DATA_DIR ??
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "recallflow")
    : process.platform === "win32"
      ? join(process.env.APPDATA!, "recallflow")
      : join(homedir(), ".config", "recallflow"));
const identity = JSON.parse(
  await readFile(join(root, "identity.json"), "utf8"),
) as { id: string };
const db = new PrismaClient();
try {
  const repo = new PostgresRepository(db, identity.id);
  await repo.init();
  const m = createMeeting(identity.id, "[Sample] Onboarding planning");
  m.startedAt = m.createdAt;
  m.endedAt = m.createdAt;
  m.durationSeconds = 30;
  m.status = "complete";
  m.notes = "★ Prioritize the welcome screen.\nConfirm analytics ownership.";
  m.segments = MOCK_LINES.map((text, i) => ({
    id: crypto.randomUUID(),
    meetingId: m.id,
    text,
    speaker: `Sample speaker ${(i % 2) + 1}`,
    startTimeMs: i * 5000,
    endTimeMs: (i + 1) * 5000,
    confidence: 1,
    createdAt: m.createdAt,
  }));
  const ai = new MockAIProvider();
  const context = normalize(m);
  const extraction = await ai.extract(context);
  m.summary = {
    ...(await ai.present(context, extraction)),
    extraction,
    createdAt: m.createdAt,
  };
  m.actions = extraction.actionItems.map((a) => ({
    ...a,
    id: crypto.randomUUID(),
    status: "open",
  }));
  await repo.save(m);
  console.log("Created labelled sample meeting.");
} finally {
  await db.$disconnect();
}
