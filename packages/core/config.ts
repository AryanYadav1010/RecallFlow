import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { z } from "zod";
import {
  AI_PROVIDERS,
  TRANSCRIPTION_PROVIDERS,
  UserFacingError,
  WHISPER_MODELS,
  WhisperModelSchema,
  type AIProviderId,
  type TranscriptionProviderId,
} from "../shared";
const blankIsUnset = (value: unknown) =>
  typeof value === "object" && value
    ? Object.fromEntries(
        Object.entries(value).filter(([, v]) => v !== "" && v !== undefined),
      )
    : value;
export const EnvSchema = z.preprocess(
  blankIsUnset,
  z.object({
    APP_MODE: z.enum(["local", "database"]).default("local"),
    DATABASE_URL: z.string().optional(),
    // Unset providers are auto-detected at startup; see resolveConfig.
    TRANSCRIPTION_PROVIDER: z.enum(TRANSCRIPTION_PROVIDERS).optional(),
    DEEPGRAM_API_KEY: z.string().optional(),
    AI_PROVIDER: z.enum(AI_PROVIDERS).optional(),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default("gpt-4o-mini"),
    ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-20250514"),
    WHISPER_MODEL: WhisperModelSchema.default("base"),
    WHISPER_MODEL_PATH: z.string().optional(),
    WHISPER_MODEL_DIR: z.string().optional(),
    WHISPER_SERVER_PATH: z.string().optional(),
    OLLAMA_HOST: z.string().url().default("http://127.0.0.1:11434"),
    OLLAMA_MODEL: z.string().min(1).default("qwen3:4b"),
    OLLAMA_NUM_CTX: z.coerce
      .number()
      .int()
      .min(2048)
      .max(262144)
      .default(32768),
  }),
);
export type RawConfig = z.infer<typeof EnvSchema>;
export type Config = RawConfig & {
  TRANSCRIPTION_PROVIDER: TranscriptionProviderId;
  AI_PROVIDER: AIProviderId;
};
export const defaultModelDir = () => join(homedir(), ".recallflow", "models");
export function whisperModelPath(config: RawConfig) {
  return (
    config.WHISPER_MODEL_PATH ??
    join(
      config.WHISPER_MODEL_DIR ?? defaultModelDir(),
      WHISPER_MODELS[config.WHISPER_MODEL].file,
    )
  );
}
/**
 * Apps launched from Finder get a minimal PATH without Homebrew, so the
 * usual install locations are searched explicitly.
 */
export function whisperServerCandidates(config: RawConfig) {
  if (config.WHISPER_SERVER_PATH) return [config.WHISPER_SERVER_PATH];
  const name =
    process.platform === "win32" ? "whisper-server.exe" : "whisper-server";
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  return [...new Set(dirs)].map((d) => join(d, name));
}
export type Detected = { whisperReady: boolean; ollamaReachable: boolean };
/**
 * Fills in unset providers, preferring local ones that are actually usable,
 * then checks that every selected cloud provider has its key.
 */
export function resolveConfig(raw: RawConfig, detected: Detected): Config {
  const config: Config = {
    ...raw,
    TRANSCRIPTION_PROVIDER:
      raw.TRANSCRIPTION_PROVIDER ??
      (detected.whisperReady ? "whisper" : "mock"),
    AI_PROVIDER:
      raw.AI_PROVIDER ?? (detected.ollamaReachable ? "ollama" : "mock"),
  };
  for (const [needed, key] of [
    [config.APP_MODE === "database", "DATABASE_URL"],
    [config.TRANSCRIPTION_PROVIDER === "deepgram", "DEEPGRAM_API_KEY"],
    [config.AI_PROVIDER === "openai", "OPENAI_API_KEY"],
    [config.AI_PROVIDER === "anthropic", "ANTHROPIC_API_KEY"],
  ] as const)
    if (needed && !config[key]?.trim())
      throw new UserFacingError(`${key} is required for the selected provider`);
  return config;
}
