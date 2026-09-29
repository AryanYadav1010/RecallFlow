import { access, constants } from "node:fs/promises";
import {
  DeepgramProvider,
  MockTranscriptionProvider,
  type TranscriptionProvider,
} from "../transcription";
import { WhisperCppProvider } from "../transcription/whisper";
import { MockAIProvider, RemoteAIProvider, type AIProvider } from "../ai";
import { OllamaAIProvider } from "../ai/ollama";
import {
  UserFacingError,
  type LocalModeStatus,
  type ProviderId,
  type ProviderStatus,
} from "../shared";
import {
  whisperModelPath,
  whisperServerCandidates,
  type Config,
  type Detected,
  type RawConfig,
} from "./config";
const exists = (path: string, mode = constants.R_OK) =>
  access(path, mode).then(
    () => true,
    () => false,
  );
export function isLoopback(url: string | undefined) {
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(url ?? "").hostname,
    );
  } catch {
    return false;
  }
}
export async function findWhisperServer(config: RawConfig) {
  for (const candidate of whisperServerCandidates(config))
    if (await exists(candidate, constants.X_OK)) return candidate;
  return null;
}
export async function probeOllama(host: string, request: typeof fetch = fetch) {
  try {
    const response = await request(new URL("/api/tags", host).href, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { reachable: false, models: [] };
    const body = (await response.json()) as { models?: { name: string }[] };
    return {
      reachable: true,
      models: (body.models ?? []).map((m) => m.name),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}
const hasModel = (models: string[], model: string) =>
  models.includes(model) || models.includes(`${model}:latest`);
export async function detectLocalProviders(
  raw: RawConfig,
  request: typeof fetch = fetch,
): Promise<Detected> {
  const [model, server, ollama] = await Promise.all([
    exists(whisperModelPath(raw)),
    raw.TRANSCRIPTION_PROVIDER ? null : findWhisperServer(raw),
    raw.AI_PROVIDER ? null : probeOllama(raw.OLLAMA_HOST, request),
  ]);
  return {
    whisperReady: model && !!server,
    ollamaReachable: !!ollama?.reachable,
  };
}
export function createProviders(
  config: Config,
  whisperServer: string | null,
): { transcription: TranscriptionProvider; ai: AIProvider } {
  const transcription =
    config.TRANSCRIPTION_PROVIDER === "whisper"
      ? new WhisperCppProvider({
          model: config.WHISPER_MODEL,
          modelPath: whisperModelPath(config),
          serverPath: whisperServer,
        })
      : config.TRANSCRIPTION_PROVIDER === "deepgram"
        ? new DeepgramProvider(config.DEEPGRAM_API_KEY!)
        : new MockTranscriptionProvider();
  const ai =
    config.AI_PROVIDER === "ollama"
      ? new OllamaAIProvider({
          host: config.OLLAMA_HOST,
          model: config.OLLAMA_MODEL,
          maxContext: config.OLLAMA_NUM_CTX,
        })
      : config.AI_PROVIDER === "openai" || config.AI_PROVIDER === "anthropic"
        ? new RemoteAIProvider({
            provider: config.AI_PROVIDER,
            key:
              config.AI_PROVIDER === "openai"
                ? config.OPENAI_API_KEY!
                : config.ANTHROPIC_API_KEY!,
            model:
              config.AI_PROVIDER === "openai"
                ? config.OPENAI_MODEL
                : config.ANTHROPIC_MODEL,
          })
        : new MockAIProvider();
  return { transcription, ai };
}
/**
 * "Local Mode" is claimed only when both meeting pipelines stay on this
 * device. Anything else that moves meeting data off it is listed.
 */
export function localMode(config: Config): LocalModeStatus {
  const localPair =
    config.TRANSCRIPTION_PROVIDER === "whisper" &&
    config.AI_PROVIDER === "ollama";
  const caveats: string[] = [];
  if (localPair && !isLoopback(config.OLLAMA_HOST))
    caveats.push(
      `Ollama is configured at ${config.OLLAMA_HOST}, which is not this device.`,
    );
  if (config.APP_MODE === "database" && !isLoopback(config.DATABASE_URL))
    caveats.push(
      "Meetings are stored in a PostgreSQL database that is not on this device.",
    );
  return { active: localPair && isLoopback(config.OLLAMA_HOST), caveats };
}
const keyStatus = (key: string | undefined) =>
  key?.trim()
    ? { ready: true, detail: "API key saved · use Test to verify" }
    : { ready: false, detail: "API key missing" };
export async function providerStatuses(
  config: Config,
  whisperServer: string | null,
  request: typeof fetch = fetch,
): Promise<ProviderStatus[]> {
  const modelPath = whisperModelPath(config);
  const [modelReady, ollama] = await Promise.all([
    exists(modelPath),
    probeOllama(config.OLLAMA_HOST, request),
  ]);
  const pulled = hasModel(ollama.models, config.OLLAMA_MODEL);
  return [
    {
      id: "whisper",
      label: "Local Whisper",
      kind: "transcription",
      local: true,
      ready: modelReady && !!whisperServer,
      detail: !whisperServer
        ? "whisper-server not found · brew install whisper-cpp"
        : modelReady
          ? `Ready · ${config.WHISPER_MODEL} model`
          : `Model missing · ${modelPath}`,
    },
    {
      id: "deepgram",
      label: "Deepgram",
      kind: "transcription",
      local: false,
      ...keyStatus(config.DEEPGRAM_API_KEY),
    },
    {
      id: "ollama",
      label: "Ollama",
      kind: "ai",
      local: isLoopback(config.OLLAMA_HOST),
      ready: ollama.reachable && pulled,
      detail: !ollama.reachable
        ? `Not running at ${config.OLLAMA_HOST}`
        : pulled
          ? `Connected — ${config.OLLAMA_MODEL}`
          : `Connected · ${config.OLLAMA_MODEL} not pulled (ollama pull ${config.OLLAMA_MODEL})`,
    },
    {
      id: "openai",
      label: "OpenAI",
      kind: "ai",
      local: false,
      ...keyStatus(config.OPENAI_API_KEY),
    },
    {
      id: "anthropic",
      label: "Anthropic",
      kind: "ai",
      local: false,
      ...keyStatus(config.ANTHROPIC_API_KEY),
    },
  ];
}
/** Connection tests. None of them send meeting content. */
export async function testProvider(
  id: ProviderId,
  config: Config,
  whisperServer: string | null,
  request: typeof fetch = fetch,
): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
  const auth = async (label: string, url: string, headers: HeadersInit) => {
    const response = await request(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401 || response.status === 403)
      throw new UserFacingError(`${label} rejected the API key.`);
    if (!response.ok)
      throw new UserFacingError(`${label} returned ${response.status}.`);
    return `${label} accepted the API key.`;
  };
  const requireKey = (label: string, key: string | undefined) => {
    if (!key?.trim()) throw new UserFacingError(`${label} API key missing.`);
    return key;
  };
  try {
    let message: string;
    if (id === "whisper")
      message = await new WhisperCppProvider({
        model: config.WHISPER_MODEL,
        modelPath: whisperModelPath(config),
        serverPath: whisperServer,
        request,
      }).test();
    else if (id === "ollama") {
      const { reachable, models } = await probeOllama(
        config.OLLAMA_HOST,
        request,
      );
      if (!reachable)
        throw new UserFacingError(
          `Ollama is not running at ${config.OLLAMA_HOST}.`,
        );
      if (!hasModel(models, config.OLLAMA_MODEL))
        throw new UserFacingError(
          `${config.OLLAMA_MODEL} is not pulled. Run: ollama pull ${config.OLLAMA_MODEL}`,
        );
      const response = await request(
        new URL("/api/generate", config.OLLAMA_HOST).href,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(120000),
          body: JSON.stringify({
            model: config.OLLAMA_MODEL,
            prompt: "Reply with OK.",
            stream: false,
            think: false,
            options: { num_predict: 1 },
          }),
        },
      );
      if (!response.ok)
        throw new UserFacingError(
          `Ollama could not run ${config.OLLAMA_MODEL} (${response.status}).`,
        );
      message = `Connected — ${config.OLLAMA_MODEL} loaded and responded in ${seconds()} s`;
    } else if (id === "deepgram")
      message = await auth("Deepgram", "https://api.deepgram.com/v1/projects", {
        Authorization: `Token ${requireKey("Deepgram", config.DEEPGRAM_API_KEY)}`,
      });
    else if (id === "openai")
      message = await auth("OpenAI", "https://api.openai.com/v1/models", {
        Authorization: `Bearer ${requireKey("OpenAI", config.OPENAI_API_KEY)}`,
      });
    else
      message = await auth("Anthropic", "https://api.anthropic.com/v1/models", {
        "x-api-key": requireKey("Anthropic", config.ANTHROPIC_API_KEY),
        "anthropic-version": "2023-06-01",
      });
    return { ok: true, message };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof UserFacingError
          ? error.message
          : "Could not reach the provider. Check the network and try again.",
    };
  }
}
