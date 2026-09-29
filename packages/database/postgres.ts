import type { PrismaClient, Prisma } from "./generated";
import type {
  Meeting,
  MeetingStatus,
  Template,
  Summary,
  ActionItem,
  ChatMessage,
} from "../shared";
import type { MeetingRepository } from "./index";
const include = {
  notes: true,
  segments: { orderBy: { startTimeMs: "asc" as const } },
  summary: true,
  actions: true,
  chat: { orderBy: { createdAt: "asc" as const } },
};
type Row = Prisma.MeetingGetPayload<{ include: typeof include }>;
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function decode(row: Row): Meeting {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    template: row.template as Template,
    status: row.status as MeetingStatus,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    error: row.error,
    notes: row.notes?.content ?? "",
    segments: row.segments.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
    })),
    summary: row.summary
      ? {
          overview: row.summary.overview,
          detailedNotes: row.summary.detailedNotes,
          suggestedFollowUp: row.summary.suggestedFollowUp,
          extraction: row.summary
            .extraction as unknown as Summary["extraction"],
          createdAt: row.summary.createdAt.toISOString(),
        }
      : null,
    actions: row.actions.map((a) => ({
      id: a.id,
      description: a.description,
      owner: a.owner,
      dueDate: a.dueDate,
      status: a.status as ActionItem["status"],
      evidenceSegmentIds: a.evidenceSegmentIds as string[],
    })),
    chat: row.chat.map((c) => ({
      id: c.id,
      role: c.role as ChatMessage["role"],
      content: c.content,
      createdAt: c.createdAt.toISOString(),
      kind: (c.kind ?? undefined) as ChatMessage["kind"],
      evidenceSegmentIds: c.evidenceSegmentIds as string[],
    })),
  };
}
export class PostgresRepository implements MeetingRepository {
  constructor(
    readonly db: PrismaClient,
    readonly userId: string,
  ) {}
  async init() {
    await this.db.user.upsert({
      where: { id: this.userId },
      create: { id: this.userId, name: "Local workspace" },
      update: {},
    });
  }
  async get(id: string) {
    const row = await this.db.meeting.findFirst({
      where: { id, userId: this.userId },
      include,
    });
    if (!row) throw new Error("Meeting not found");
    return decode(row);
  }
  async list(query = "") {
    let ids: string[] | undefined;
    if (query.trim()) {
      const rows = await this.db.$queryRaw<
        { id: string }[]
      >`SELECT m.id FROM "Meeting" m WHERE m."userId" = ${this.userId}::uuid AND (to_tsvector('english', m.title) @@ plainto_tsquery('english', ${query}) OR m.title ILIKE ${"%" + query + "%"} OR EXISTS (SELECT 1 FROM "RawNote" n WHERE n."meetingId"=m.id AND to_tsvector('english',n.content) @@ plainto_tsquery('english',${query})) OR EXISTS (SELECT 1 FROM "TranscriptSegment" t WHERE t."meetingId"=m.id AND to_tsvector('english',t.text) @@ plainto_tsquery('english',${query})) OR EXISTS (SELECT 1 FROM "MeetingSummary" s WHERE s."meetingId"=m.id AND to_tsvector('english',s.overview || ' ' || s."detailedNotes") @@ plainto_tsquery('english',${query})))`;
      ids = rows.map((r) => r.id);
    }
    return (
      await this.db.meeting.findMany({
        where: { userId: this.userId, ...(ids ? { id: { in: ids } } : {}) },
        include,
        orderBy: { createdAt: "desc" },
      })
    ).map(decode);
  }
  async save(m: Meeting) {
    if (m.userId !== this.userId) throw new Error("Meeting not found");
    await this.db.$transaction(async (tx) => {
      const existing = await tx.meeting.findUnique({
        where: { id: m.id },
        select: { userId: true },
      });
      if (existing && existing.userId !== this.userId)
        throw new Error("Meeting not found");
      const data = {
        title: m.title,
        template: m.template,
        status: m.status,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        durationSeconds: m.durationSeconds,
        error: m.error,
        updatedAt: m.updatedAt,
      };
      await tx.meeting.upsert({
        where: { id: m.id },
        create: {
          id: m.id,
          userId: this.userId,
          createdAt: m.createdAt,
          ...data,
        },
        update: data,
      });
      await tx.rawNote.upsert({
        where: { meetingId: m.id },
        create: { meetingId: m.id, content: m.notes },
        update: { content: m.notes },
      });
      await tx.transcriptSegment.deleteMany({
        where: { meetingId: m.id, id: { notIn: m.segments.map((s) => s.id) } },
      });
      await tx.transcriptSegment.createMany({
        data: m.segments,
        skipDuplicates: true,
      });
      if (m.summary) {
        const s = m.summary;
        const data = {
          overview: s.overview,
          detailedNotes: s.detailedNotes,
          suggestedFollowUp: s.suggestedFollowUp,
          topics: json(s.extraction.topics),
          decisions: json(s.extraction.decisions),
          questions: json(s.extraction.questions),
          risks: json(s.extraction.risks),
          importantFacts: json(s.extraction.importantFacts),
          extraction: json(s.extraction),
        };
        await tx.meetingSummary.upsert({
          where: { meetingId: m.id },
          create: { meetingId: m.id, ...data },
          update: data,
        });
      }
      await tx.actionItem.deleteMany({ where: { meetingId: m.id } });
      await tx.actionItem.createMany({
        data: m.actions.map((a) => ({
          ...a,
          meetingId: m.id,
          evidenceSegmentIds: json(a.evidenceSegmentIds),
          sourceTranscriptSegmentId: a.evidenceSegmentIds[0] ?? null,
        })),
      });
      await tx.participant.deleteMany({ where: { meetingId: m.id } });
      await tx.participant.createMany({
        data: (m.summary?.extraction.participants ?? []).map((name) => ({
          meetingId: m.id,
          name,
        })),
      });
      await tx.chatMessage.createMany({
        data: m.chat.map((c) => ({
          ...c,
          meetingId: m.id,
          evidenceSegmentIds: json(c.evidenceSegmentIds ?? []),
        })),
        skipDuplicates: true,
      });
    });
  }
  async delete(id: string) {
    await this.db.meeting.deleteMany({ where: { id, userId: this.userId } });
  }
}
