import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Cloud, CheckCircle2, Loader2 } from "lucide-react";
import { api, errorMessage } from "./api";
import {
  OLLAMA_SUGGESTED_MODELS,
  WHISPER_MODELS,
  type AIProviderId,
  type AppInfo,
  type ProviderId,
  type TranscriptionProviderId,
  type WhisperModel,
} from "../../../packages/shared";
type TestResult = { ok: boolean; message: string } | "running";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
export function AIConfiguration({ info }: { info: AppInfo }) {
  const client = useQueryClient();
  const statuses = useQuery({
    queryKey: ["providers"],
    queryFn: api.providers,
  });
  const [transcription, setTranscription] = useState<TranscriptionProviderId>(
    info.transcription,
  );
  const [ai, setAI] = useState<AIProviderId>(info.ai);
  const [whisperModel, setWhisperModel] = useState<WhisperModel>(
    info.whisper.model,
  );
  const [ollamaModel, setOllamaModel] = useState(info.ollama.model);
  const [keys, setKeys] = useState({ deepgram: "", openai: "", anthropic: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Partial<Record<ProviderId, TestResult>>>(
    {},
  );
  const dirty =
    transcription !== info.transcription ||
    ai !== info.ai ||
    whisperModel !== info.whisper.model ||
    ollamaModel !== info.ollama.model ||
    Object.values(keys).some(Boolean);
  const status = (id: ProviderId) => statuses.data?.find((s) => s.id === id);
  const modelPath = info.whisper.modelPath.replace(
    WHISPER_MODELS[info.whisper.model].file,
    WHISPER_MODELS[whisperModel].file,
  );
  const cloud = [
    info.transcription === "deepgram" && "Deepgram (transcription)",
    (info.ai === "openai" || info.ai === "anthropic") &&
      `${info.ai === "openai" ? "OpenAI" : "Anthropic"} (meeting intelligence)`,
  ].filter(Boolean);
  async function save(choice = { transcription, ai }) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.configure({
        transcriptionProvider: choice.transcription,
        aiProvider: choice.ai,
        whisperModel,
        ollamaModel: ollamaModel.trim() || undefined,
        deepgramKey: keys.deepgram,
        openaiKey: keys.openai,
        anthropicKey: keys.anthropic,
      });
      setKeys({ deepgram: "", openai: "", anthropic: "" });
      setTests({});
      await client.invalidateQueries({ queryKey: ["info"] });
      await client.invalidateQueries({ queryKey: ["providers"] });
      setNotice(
        "Providers updated. Keys are encrypted with OS secure storage.",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function test(id: ProviderId) {
    setTests((t) => ({ ...t, [id]: "running" }));
    const result = await api
      .testProvider(id)
      .catch((e: unknown) => ({ ok: false, message: errorMessage(e) }));
    setTests((t) => ({ ...t, [id]: result }));
    void statuses.refetch();
  }
  const statusPill = (id: ProviderId) => {
    const s = status(id);
    if (!s) return <span className="status-pill">Checking…</span>;
    return (
      <span className={`status-pill ${s.ready ? "complete" : "failed"}`}>
        {s.ready ? "Ready" : "Not ready"}
      </span>
    );
  };
  const testRow = (id: ProviderId) => {
    const result = tests[id];
    return (
      <div className="provider-test">
        <span>{status(id)?.detail ?? "Checking…"}</span>
        <button
          type="button"
          className="secondary"
          disabled={dirty || result === "running"}
          title={dirty ? "Save your changes first" : undefined}
          onClick={() => void test(id)}
        >
          {result === "running" ? (
            <>
              <Loader2 size={12} className="spin" /> Testing…
            </>
          ) : (
            "Test"
          )}
        </button>
        {result && result !== "running" && (
          <p role="status" className={result.ok ? "test-ok" : "danger-text"}>
            {result.message}
          </p>
        )}
      </div>
    );
  };
  const keyField = (name: keyof typeof keys, label: string) => (
    <label>
      {label} API key
      <input
        type="password"
        autoComplete="off"
        value={keys[name]}
        onChange={(e) => setKeys({ ...keys, [name]: e.target.value })}
        placeholder="Enter key, or leave blank to keep existing"
      />
    </label>
  );
  const choice = <T extends string>(
    group: string,
    value: T,
    current: T,
    set: (v: T) => void,
    label: string,
    hint: string,
    id?: ProviderId,
  ) => (
    <label className={`provider-option ${value === current ? "selected" : ""}`}>
      <input
        type="radio"
        name={group}
        value={value}
        checked={value === current}
        onChange={() => set(value)}
      />
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      {id && statusPill(id)}
    </label>
  );
  const showMock = info.development || info.transcription === "mock";
  const showMockAI = info.development || info.ai === "mock";
  return (
    <div className="settings-section">
      <h2>AI configuration</h2>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="settings-notice">
          <CheckCircle2 size={14} />
          {notice}
        </p>
      )}
      <div className={`privacy-mode ${info.localMode.active ? "active" : ""}`}>
        <div>
          <span className="eyebrow">PRIVACY MODE</span>
          <strong>Fully Local</strong>
          <p>
            Recommended for private/personal use. No meeting transcript is
            intentionally sent to cloud AI services.
          </p>
          {info.localMode.active ? (
            <p className="local-mode-line">
              <ShieldCheck size={14} />
              <span>
                <b>Local Mode</b> — Transcription and meeting intelligence are
                processed locally on this device.
              </span>
            </p>
          ) : cloud.length ? (
            <p className="cloud-line">
              <Cloud size={14} /> Cloud processing in use: {cloud.join(" · ")}
            </p>
          ) : null}
          {info.localMode.caveats.map((c) => (
            <p key={c} className="cloud-line">
              <Cloud size={14} /> {c}
            </p>
          ))}
        </div>
        <button
          type="button"
          disabled={busy || info.localMode.active || !info.secureStorage}
          onClick={() => {
            setTranscription("whisper");
            setAI("ollama");
            void save({ transcription: "whisper", ai: "ollama" });
          }}
        >
          {info.localMode.active ? "Fully local is on" : "Use fully local"}
        </button>
      </div>
      <form
        className="provider-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="provider-group">
          <legend>TRANSCRIPTION</legend>
          {choice(
            "transcription",
            "whisper",
            transcription,
            setTranscription,
            "Local Whisper",
            "whisper.cpp on this device · audio never leaves it",
            "whisper",
          )}
          {choice(
            "transcription",
            "deepgram",
            transcription,
            setTranscription,
            "Deepgram",
            "Cloud streaming · live partial results · speaker labels",
            "deepgram",
          )}
          {showMock &&
            choice(
              "transcription",
              "mock",
              transcription,
              setTranscription,
              "Mock preview",
              "Scripted sample text for development",
            )}
          {transcription === "whisper" && (
            <div className="provider-details">
              <label>
                Model
                <select
                  aria-label="Whisper model"
                  value={whisperModel}
                  onChange={(e) =>
                    setWhisperModel(e.target.value as WhisperModel)
                  }
                >
                  {Object.entries(WHISPER_MODELS).map(([name, m]) => (
                    <option key={name} value={name}>
                      {name} · {m.diskMB} MB download · ~{m.memoryMB} MB RAM
                    </option>
                  ))}
                </select>
              </label>
              <div className="model-location">
                <span>Model location</span>
                <code>{modelPath}</code>
              </div>
              {testRow("whisper")}
              {status("whisper")?.detail.startsWith("Model missing") && (
                <p className="settings-note">
                  Download it with:{" "}
                  <code>
                    curl -L --create-dirs -o &quot;{modelPath}&quot;{" "}
                    {MODEL_URL + WHISPER_MODELS[whisperModel].file}
                  </code>
                </p>
              )}
            </div>
          )}
          {transcription === "deepgram" && (
            <div className="provider-details">
              {keyField("deepgram", "Deepgram")}
              {testRow("deepgram")}
            </div>
          )}
        </fieldset>
        <fieldset className="provider-group">
          <legend>MEETING INTELLIGENCE</legend>
          {choice(
            "ai",
            "ollama",
            ai,
            setAI,
            "Ollama",
            "Local model on this device · no API key",
            "ollama",
          )}
          {choice(
            "ai",
            "openai",
            ai,
            setAI,
            "OpenAI",
            "Cloud model · requires an API key",
            "openai",
          )}
          {choice(
            "ai",
            "anthropic",
            ai,
            setAI,
            "Anthropic",
            "Cloud model · requires an API key",
            "anthropic",
          )}
          {showMockAI &&
            choice(
              "ai",
              "mock",
              ai,
              setAI,
              "Mock preview",
              "Deterministic output for development",
            )}
          {ai === "ollama" && (
            <div className="provider-details">
              <label>
                Model
                <input
                  aria-label="Ollama model"
                  list="ollama-models"
                  value={ollamaModel}
                  onChange={(e) => setOllamaModel(e.target.value)}
                />
                <datalist id="ollama-models">
                  {OLLAMA_SUGGESTED_MODELS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <div className="model-location">
                <span>Server</span>
                <code>{info.ollama.host}</code>
              </div>
              {testRow("ollama")}
            </div>
          )}
          {ai === "openai" && (
            <div className="provider-details">
              {keyField("openai", "OpenAI")}
              {testRow("openai")}
            </div>
          )}
          {ai === "anthropic" && (
            <div className="provider-details">
              {keyField("anthropic", "Anthropic")}
              {testRow("anthropic")}
            </div>
          )}
        </fieldset>
        <button disabled={busy || !dirty || !info.secureStorage} type="submit">
          {busy ? "Saving…" : "Save providers securely"}
        </button>
        <p className="settings-note">
          {info.secureStorage
            ? "Keys use OS-backed encryption and are never returned to this page. Explicit environment variables take precedence after restart. Tests use the saved configuration and never send meeting content."
            : "OS-backed encryption is unavailable. Configure providers in the trusted launch environment."}
        </p>
        <p className="settings-note">
          Local inference uses this computer&apos;s CPU, GPU and memory. Whisper
          base needs about 0.4 GB of RAM while a meeting records; Ollama with
          qwen3:4b needs roughly 4–6 GB while notes are generated and makes the
          fans work for a minute or two.
        </p>
      </form>
      <div className="provider-status-list">
        <h3>Provider status</h3>
        {(statuses.data ?? []).map((s) => (
          <div key={s.id} className="provider-status-row">
            <strong>{s.label}</strong>
            <span className={s.ready ? "test-ok" : "muted"}>{s.detail}</span>
            <span className="provider-pill">{s.local ? "local" : "cloud"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
