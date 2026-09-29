import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Mic,
  MicOff,
  PenLine,
  Square,
  X,
} from "lucide-react";
import {
  FLOATING_SIZES,
  idleSession,
  type FloatingAPI,
  type FloatingSize,
  type SessionState,
} from "../../../packages/shared";
import "./floating.css";
declare global {
  interface Window {
    floating: FloatingAPI;
  }
}
const api = window.floating;
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};
const labels = {
  microphone: {
    waiting: "Starting…",
    connected: "On",
    disconnected: "Disconnected",
    off: "Off",
  },
  systemAudio: {
    waiting: "Waiting for share",
    connected: "On",
    unavailable: "Unavailable",
    off: "Off",
  },
  transcription: {
    connecting: "Connecting…",
    connected: "Connected",
    reconnecting: "Interrupted",
    failed: "Failed",
    off: "Off",
  },
};
/** Resolves once the renderer sees the window at the requested height. */
const fitted = (height: number) =>
  new Promise<void>((resolve) => {
    if (window.innerHeight === height) return resolve();
    const done = () => {
      window.removeEventListener("resize", check);
      resolve();
    };
    const check = () => window.innerHeight === height && done();
    window.addEventListener("resize", check);
    setTimeout(done, 250);
  });
const afterLabels: Partial<Record<SessionState["phase"], string>> = {
  stopping: "Finishing transcript…",
  processing: "Processing notes…",
  ready: "Notes ready",
  failed: "Notes need attention",
};
function Floating() {
  const [state, setState] = useState<SessionState>(idleSession);
  const [size, setSize] = useState<FloatingSize>("collapsed");
  const [confirmStop, setConfirmStop] = useState(false);
  const [note, setNote] = useState("");
  const [noteStatus, setNoteStatus] = useState("");
  const [now, setNow] = useState(Date.now());
  const current = useRef(size);
  current.current = size;
  // Bigger views wait for the window to grow; smaller views shrink it after.
  // Otherwise content and window size disagree and clicks can land on the
  // wrong control.
  const show = useCallback(async (next: FloatingSize) => {
    const target = FLOATING_SIZES[next];
    if (target.height > FLOATING_SIZES[current.current].height) {
      await api.resize(next);
      await fitted(target.height);
      setSize(next);
    } else {
      setSize(next);
      await api.resize(next);
    }
  }, []);
  const recording = state.phase === "recording";
  useEffect(() => {
    void api.session().then(setState);
    return api.onSession(setState);
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    // A new phase starts compact; the note form only exists while recording.
    void show("collapsed");
    setConfirmStop(false);
  }, [state.phase, show]);
  useEffect(() => {
    if (!confirmStop) return;
    const timer = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmStop]);
  const elapsed = state.startedAt
    ? clock(now - Date.parse(state.startedAt))
    : "";
  const stop = () => {
    // Two clicks, so a stray click on a small control cannot end a meeting.
    if (!confirmStop) return setConfirmStop(true);
    setConfirmStop(false);
    void api.stop();
  };
  const stopButton = (
    <button
      className={`control stop ${confirmStop ? "confirm" : ""}`}
      aria-label={confirmStop ? "Confirm stop" : "Stop meeting"}
      title={confirmStop ? "Click again to stop" : "Stop meeting"}
      onClick={stop}
    >
      <Square size={11} fill="currentColor" />
      {confirmStop && <span>Stop?</span>}
    </button>
  );
  const micIcon =
    state.microphone === "disconnected" ? (
      <MicOff size={14} aria-label="Microphone disconnected" />
    ) : (
      <Mic
        size={14}
        aria-label={`Microphone ${labels.microphone[state.microphone]}`}
      />
    );
  if (state.phase === "idle") return null;
  if (!recording)
    return (
      <main className="shell">
        <div className="pill">
          {state.phase === "ready" ? (
            <Check size={15} className="ok" />
          ) : state.phase === "failed" ? (
            <AlertTriangle size={15} className="warn" />
          ) : (
            <Loader2 size={15} className="spin" />
          )}
          <span className="status-text" title={state.message ?? undefined}>
            {afterLabels[state.phase]}
          </span>
          <button
            className="control"
            aria-label="Open full meeting"
            title="Open full meeting"
            onClick={() => void api.openMeeting()}
          >
            <ExternalLink size={13} />
          </button>
          {state.phase !== "stopping" && (
            <button
              className="control"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => void api.dismiss()}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </main>
    );
  if (size === "collapsed")
    return (
      <main className="shell">
        <div className="pill">
          <i className="dot" aria-hidden />
          <span className="elapsed" aria-label="Elapsed time">
            {elapsed}
          </span>
          <span
            className={`mic ${state.microphone === "connected" ? "on" : ""}`}
          >
            {micIcon}
          </span>
          {stopButton}
          <button
            className="control"
            aria-label="Expand meeting controls"
            onClick={() => void show("expanded")}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </main>
    );
  return (
    <main className="shell">
      <div className="card">
        <header>
          <i className="dot" aria-hidden />
          <strong>Recording</strong>
          <span className="elapsed" aria-label="Elapsed time">
            {elapsed}
          </span>
          <button
            className="control"
            aria-label="Collapse meeting controls"
            onClick={() => void show("collapsed")}
          >
            <ChevronUp size={14} />
          </button>
        </header>
        <p className="title">{state.title}</p>
        <dl>
          <dt>Transcription</dt>
          <dd className={state.transcription}>
            {labels.transcription[state.transcription]}
          </dd>
          <dt>Microphone</dt>
          <dd className={state.microphone}>
            {labels.microphone[state.microphone]}
          </dd>
          <dt>System audio</dt>
          <dd className={state.systemAudio}>
            {labels.systemAudio[state.systemAudio]}
          </dd>
        </dl>
        {state.message && <p className="message">{state.message}</p>}
        {size === "note" ? (
          <form
            className="note"
            onSubmit={(e) => {
              e.preventDefault();
              if (!note.trim()) return;
              void api
                .note(note)
                .then(() => {
                  setNote("");
                  setNoteStatus("Added to My Notes");
                  void show("expanded");
                })
                .catch(() => setNoteStatus("Could not add the note"));
            }}
          >
            <input
              autoFocus
              aria-label="Quick note"
              placeholder="Quick note…"
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && void show("expanded")}
            />
            <div className="actions">
              <button type="submit" className="action primary">
                Add note
              </button>
              <button
                type="button"
                className="action"
                onClick={() => void show("expanded")}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="actions">
            <button
              className="action"
              onClick={() => {
                setNoteStatus("");
                void show("note");
              }}
            >
              <PenLine size={12} /> Quick note
            </button>
            <button className="action" onClick={() => void api.openMeeting()}>
              <ExternalLink size={12} /> Open meeting
            </button>
            {stopButton}
          </div>
        )}
        {noteStatus && size !== "note" && (
          <p className="note-status" role="status">
            {noteStatus}
          </p>
        )}
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Floating />
  </StrictMode>,
);
