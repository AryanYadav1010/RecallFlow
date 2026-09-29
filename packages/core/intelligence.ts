import { type AIProvider, normalize, groundExtraction } from "../ai";
import {
  AnswerSchema,
  PresentationSchema,
  UserFacingError,
  transition,
} from "../shared";
import type { MeetingService } from "./service";
export class IntelligenceService {
  private generating = new Set<string>();
  private chatting = new Set<string>();
  constructor(
    private service: MeetingService,
    private ai: AIProvider,
  ) {}
  async generate(id: string) {
    if (this.generating.has(id))
      throw new Error("Intelligence is already being generated");
    this.generating.add(id);
    try {
      await this.service.recoverPending();
      let m = await this.service.repository.get(id);
      if (m.status === "draft" || m.status === "recording")
        throw new Error("Stop the meeting before generating notes");
      m = await this.service.update(id, (current) => {
        if (current.status !== "processing")
          current.status = transition(current.status, "processing");
      });
      const context = normalize(m);
      const extraction = groundExtraction(
        m.summary?.extraction ?? (await this.ai.extract(context)),
        context,
      );
      // Persist extraction separately before the second provider call, so retry does not redo it.
      await this.service.update(id, (current) => {
        current.summary = {
          overview: "",
          detailedNotes: "",
          suggestedFollowUp: "",
          extraction,
          createdAt: new Date().toISOString(),
        };
        current.actions = extraction.actionItems.map((a) => {
          const prior = current.actions.find(
            (p) => p.description === a.description,
          );
          return {
            ...a,
            id: prior?.id ?? crypto.randomUUID(),
            status: prior?.status ?? "open",
          };
        });
      });
      const presentation = PresentationSchema.parse(
        await this.ai.present(context, extraction),
      );
      return await this.service.update(id, (current) => {
        current.summary = {
          ...presentation,
          extraction,
          createdAt: new Date().toISOString(),
        };
        current.status = transition(current.status, "complete");
        if (current.error?.startsWith("AI generation")) current.error = null;
      });
    } catch (error) {
      const m = await this.service.repository.get(id).catch(() => null);
      if (m && m.status !== "draft" && m.status !== "recording")
        await this.service.fail(
          id,
          error instanceof UserFacingError
            ? `AI generation failed: ${error.message}`
            : "AI generation failed. Your notes and transcript are saved. Check the provider configuration and retry.",
        );
      throw error;
    } finally {
      this.generating.delete(id);
    }
  }
  async chat(id: string, question: string) {
    if (this.chatting.has(id))
      throw new Error("An answer is already being generated");
    this.chatting.add(id);
    try {
      const m = await this.service.update(id, (current) => {
        current.chat.push({
          id: crypto.randomUUID(),
          role: "user",
          content: question,
          createdAt: new Date().toISOString(),
        });
      });
      const answer = AnswerSchema.parse(
        await this.ai.answer(
          normalize(m),
          m.summary,
          question,
          m.chat.slice(0, -1),
        ),
      );
      const known = new Set(m.segments.map((s) => s.id));
      answer.evidenceSegmentIds = answer.evidenceSegmentIds.filter((id) =>
        known.has(id),
      );
      return await this.service.update(id, (current) => {
        current.chat.push({
          id: crypto.randomUUID(),
          role: "assistant",
          ...answer,
          createdAt: new Date().toISOString(),
        });
      });
    } finally {
      this.chatting.delete(id);
    }
  }
  isBusy(id: string) {
    return this.generating.has(id) || this.chatting.has(id);
  }
}
