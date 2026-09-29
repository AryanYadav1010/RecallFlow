import { z } from "zod";
export const templates = {
  general: {
    name: "General Meeting",
    sections: ["Overview", "Topics", "Decisions", "Action Items", "Questions"],
  },
  sales: {
    name: "Sales Call",
    sections: [
      "Customer Context",
      "Pain Points",
      "Current Solution",
      "Requirements",
      "Objections",
      "Buying Signals",
      "Next Steps",
    ],
  },
  interview: {
    name: "Interview",
    sections: [
      "Candidate Summary",
      "Relevant Experience",
      "Strengths Discussed",
      "Concerns",
      "Questions",
      "Next Steps",
    ],
  },
  oneOnOne: {
    name: "1:1",
    sections: [
      "Discussion",
      "Feedback",
      "Decisions",
      "Commitments",
      "Follow-ups",
    ],
  },
} as const;
export const TemplateSchema = z.enum([
  "general",
  "sales",
  "interview",
  "oneOnOne",
]);
export type Template = z.infer<typeof TemplateSchema>;
export const StatusSchema = z.enum([
  "draft",
  "recording",
  "processing",
  "complete",
  "failed",
]);
export type MeetingStatus = z.infer<typeof StatusSchema>;
const evidence = z.array(z.string()).max(100);
export const ExtractionSchema = z.object({
  topics: z.array(z.object({ name: z.string(), summary: z.string() })),
  decisions: z.array(
    z.object({ text: z.string(), evidenceSegmentIds: evidence }),
  ),
  actionItems: z.array(
    z.object({
      description: z.string(),
      owner: z.string().nullable(),
      dueDate: z.string().nullable(),
      evidenceSegmentIds: evidence,
    }),
  ),
  questions: z.array(z.string()),
  risks: z.array(z.string()),
  importantFacts: z.array(
    z.object({ text: z.string(), evidenceSegmentIds: evidence }),
  ),
  participants: z.array(z.string()),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
export const PresentationSchema = z.object({
  overview: z.string(),
  detailedNotes: z.string(),
  suggestedFollowUp: z.string(),
});
export const AnswerSchema = z.object({
  content: z.string(),
  kind: z.enum(["explicit", "inference", "unavailable"]),
  evidenceSegmentIds: evidence,
});
export type Answer = z.infer<typeof AnswerSchema>;
export type Segment = {
  id: string;
  meetingId: string;
  speaker: string;
  text: string;
  startTimeMs: number;
  endTimeMs: number;
  confidence: number;
  createdAt: string;
};
export type ActionItem = Extraction["actionItems"][number] & {
  id: string;
  status: "open" | "done";
};
export type Summary = z.infer<typeof PresentationSchema> & {
  extraction: Extraction;
  createdAt: string;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  kind?: Answer["kind"];
  evidenceSegmentIds?: string[];
};
export type Meeting = {
  id: string;
  userId: string;
  title: string;
  template: Template;
  status: MeetingStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
  notes: string;
  segments: Segment[];
  summary: Summary | null;
  actions: ActionItem[];
  chat: ChatMessage[];
  error: string | null;
};
export type Settings = {
  defaultTemplate: Template;
  transcriptRetentionDays: number | null;
  compactOnStart: boolean;
};
/** An error whose message is safe and useful to show the user verbatim. */
export class UserFacingError extends Error {
  readonly userFacing = true;
}
export const TRANSCRIPTION_PROVIDERS = ["whisper", "deepgram", "mock"] as const;
export const AI_PROVIDERS = ["ollama", "openai", "anthropic", "mock"] as const;
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDERS)[number];
export type AIProviderId = (typeof AI_PROVIDERS)[number];
export type ProviderId = Exclude<
  TranscriptionProviderId | AIProviderId,
  "mock"
>;
// Adding a model later is one entry here. Sizes are from the whisper.cpp README.
export const WHISPER_MODELS = {
  tiny: { file: "ggml-tiny.en.bin", diskMB: 75, memoryMB: 273 },
  base: { file: "ggml-base.en.bin", diskMB: 142, memoryMB: 388 },
  small: { file: "ggml-small.en.bin", diskMB: 466, memoryMB: 852 },
} as const;
export type WhisperModel = keyof typeof WHISPER_MODELS;
export const WhisperModelSchema = z.enum(
  Object.keys(WHISPER_MODELS) as [WhisperModel, ...WhisperModel[]],
);
export const OLLAMA_SUGGESTED_MODELS = [
  "qwen3:4b",
  "qwen3:8b",
  "gemma3:4b",
  "llama3.2:3b",
];
export type ProviderStatus = {
  id: ProviderId;
  label: string;
  kind: "transcription" | "ai";
  local: boolean;
  ready: boolean;
  detail: string;
};
export type LocalModeStatus = {
  /** Transcription and intelligence both run on this device. */
  active: boolean;
  /** Other enabled paths that still send meeting data off the device. */
  caveats: string[];
};
export type AppInfo = {
  mode: "local" | "database";
  ai: AIProviderId;
  transcription: TranscriptionProviderId;
  platform: string;
  microphonePermission: string;
  systemAudioSupported: boolean;
  settings: Settings;
  development: boolean;
  secureStorage: boolean;
  whisper: {
    model: WhisperModel;
    modelPath: string;
    serverPath: string | null;
  };
  ollama: { model: string; host: string };
  localMode: LocalModeStatus;
};
/**
 * The live meeting as seen by every window. The main process owns it;
 * windows only render it and send commands.
 */
export type SessionState = {
  phase: "idle" | "recording" | "stopping" | "processing" | "ready" | "failed";
  meetingId: string | null;
  title: string;
  startedAt: string | null;
  microphone: "waiting" | "connected" | "disconnected" | "off";
  systemAudio: "waiting" | "connected" | "unavailable" | "off";
  transcription: "connecting" | "connected" | "reconnecting" | "failed" | "off";
  message: string | null;
};
export const idleSession: SessionState = {
  phase: "idle",
  meetingId: null,
  title: "",
  startedAt: null,
  microphone: "off",
  systemAudio: "off",
  transcription: "off",
  message: null,
};
export type TranscriptionEvent =
  | { type: "partial"; text: string }
  | { type: "final"; segment: Segment }
  | {
      type: "connection";
      status: "connected" | "reconnecting" | "failed" | "closed";
      message?: string;
    };
export const IdSchema = z.string().uuid();
export const CreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  template: TemplateSchema,
});
export const NoteSchema = z.object({
  id: IdSchema,
  content: z.string().max(500000),
});
export const SettingsSchema = z.object({
  defaultTemplate: TemplateSchema,
  transcriptRetentionDays: z.number().int().min(1).max(3650).nullable(),
  compactOnStart: z.boolean().default(true),
});
export const ProviderConfigSchema = z.object({
  aiProvider: z.enum(AI_PROVIDERS),
  transcriptionProvider: z.enum(TRANSCRIPTION_PROVIDERS),
  deepgramKey: z.string().max(512).optional(),
  openaiKey: z.string().max(512).optional(),
  anthropicKey: z.string().max(512).optional(),
  whisperModel: WhisperModelSchema.optional(),
  ollamaModel: z
    .string()
    .trim()
    .regex(/^[\w.:/-]{1,100}$/, "Invalid model name")
    .optional(),
});
export const ProviderIdSchema = z.enum([
  "whisper",
  "deepgram",
  "ollama",
  "openai",
  "anthropic",
]);
export interface DesktopAPI {
  configure(input: z.infer<typeof ProviderConfigSchema>): Promise<void>;
  info(): Promise<AppInfo>;
  list(query?: string): Promise<Meeting[]>;
  get(id: string): Promise<Meeting>;
  create(input: z.infer<typeof CreateSchema>): Promise<Meeting>;
  saveNotes(input: z.infer<typeof NoteSchema>): Promise<void>;
  start(input: {
    id: string;
    sampleRate: number;
    systemAudio: boolean;
  }): Promise<void>;
  audio(input: { id: string; data: ArrayBuffer }): void;
  stop(id: string): Promise<Meeting>;
  generate(id: string): Promise<Meeting>;
  action(input: {
    id: string;
    actionId: string;
    done: boolean;
  }): Promise<Meeting>;
  chat(input: { id: string; question: string }): Promise<Meeting>;
  delete(id: string): Promise<void>;
  deleteAll(): Promise<void>;
  settings(input: Settings): Promise<void>;
  providers(): Promise<ProviderStatus[]>;
  testProvider(id: ProviderId): Promise<{ ok: boolean; message: string }>;
  session(): Promise<SessionState>;
  captureSource(input: {
    id: string;
    source: "microphone" | "system";
    connected: boolean;
  }): void;
  onTranscript(callback: (event: TranscriptionEvent) => void): () => void;
  onSession(callback: (state: SessionState) => void): () => void;
  /** Main process asks this window, which owns the microphone, to stop capture. */
  onCaptureRelease(callback: (meetingId: string) => void): () => void;
  onQuickNote(
    callback: (note: { meetingId: string; text: string }) => void,
  ): () => void;
  onOpenMeeting(callback: (meetingId: string) => void): () => void;
}
/** The deliberately small surface exposed to the floating meeting window. */
export interface FloatingAPI {
  session(): Promise<SessionState>;
  onSession(callback: (state: SessionState) => void): () => void;
  stop(): Promise<void>;
  openMeeting(): Promise<void>;
  dismiss(): Promise<void>;
  note(text: string): Promise<void>;
  resize(size: FloatingSize): Promise<void>;
}
export function sessionLabel(state: SessionState) {
  const title = state.title ? ` · ${state.title}` : "";
  return {
    idle: "No active meeting",
    recording: `Recording${title}`,
    stopping: `Finishing transcript${title}`,
    processing: `Processing notes${title}`,
    ready: `Notes ready${title}`,
    failed: `Notes need attention${title}`,
  }[state.phase];
}
export const FloatingSizeSchema = z.enum(["collapsed", "expanded", "note"]);
export type FloatingSize = z.infer<typeof FloatingSizeSchema>;
// Collapsed matches the 180–240 × 42–56 target; the extra pixels hold the shadow.
export const FLOATING_SIZES: Record<
  FloatingSize,
  { width: number; height: number }
> = {
  collapsed: { width: 236, height: 60 },
  expanded: { width: 300, height: 232 },
  note: { width: 300, height: 290 },
};
export function transition(
  current: MeetingStatus,
  next: MeetingStatus,
): MeetingStatus {
  const allowed: Record<MeetingStatus, MeetingStatus[]> = {
    draft: ["recording"],
    recording: ["processing", "failed"],
    processing: ["complete", "failed"],
    complete: ["processing"],
    failed: ["processing"],
  };
  if (!allowed[current].includes(next))
    throw new Error(`Cannot change meeting from ${current} to ${next}`);
  return next;
}
export function newMeeting(
  userId: string,
  input: z.infer<typeof CreateSchema>,
): Meeting {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    userId,
    ...CreateSchema.parse(input),
    status: "draft",
    startedAt: null,
    endedAt: null,
    durationSeconds: 0,
    createdAt: now,
    updatedAt: now,
    notes: "",
    segments: [],
    summary: null,
    actions: [],
    chat: [],
    error: null,
  };
}
export function markdown(m: Meeting): string {
  return [
    `# ${m.title}`,
    m.createdAt.slice(0, 10),
    `## Overview\n${m.summary?.overview ?? ""}`,
    `## Enhanced notes\n${m.summary?.detailedNotes ?? ""}`,
    `## Decisions\n${m.summary?.extraction.decisions.map((d) => `- ${d.text}`).join("\n") ?? ""}`,
    `## Action items\n${m.actions.map((a) => `- [${a.status === "done" ? "x" : " "}] ${a.description}${a.owner ? ` — ${a.owner}` : ""}${a.dueDate ? ` (${a.dueDate})` : ""}`).join("\n")}`,
    `## Questions\n${m.summary?.extraction.questions.join("\n") ?? ""}`,
    `## Risks\n${m.summary?.extraction.risks.join("\n") ?? ""}`,
    `## Important facts\n${m.summary?.extraction.importantFacts.map((f) => f.text).join("\n") ?? ""}`,
    `## Suggested follow-up\n${m.summary?.suggestedFollowUp ?? ""}`,
    `## My notes\n${m.notes}`,
    `## Transcript\n${m.segments.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join("\n\n")}`,
  ].join("\n\n");
}
