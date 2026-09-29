import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Mic,
  Monitor,
  Square,
  Radio,
  ChevronDown,
  ChevronRight,
  ShieldCheck,
  Clock,
  Trash2,
} from "lucide-react";
import type {
  Meeting,
  AppInfo,
  TranscriptionEvent,
} from "../../../packages/shared";
import { templates } from "../../../packages/shared";
import { api, errorMessage } from "./api";
import { IntelligenceView } from "./IntelligenceView";
import { AudioCapture } from "./audio";
import { NotesEditor } from "./NotesEditor";
import { useNavigation, useSession } from "./state";
import { clearDraft } from "./notes";
export function time(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
export function MeetingPage({
  meeting,
  info,
}: {
  meeting: Meeting;
  info: AppInfo;
}) {
  const client = useQueryClient();
  const nav = useNavigation();
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState("");
  const [connection, setConnection] = useState("Not connected");
  const [mic, setMic] = useState(false);
  const [system, setSystem] = useState(false);
  const [useSystem, setUseSystem] = useState(false);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(meeting.durationSeconds);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const capture = useRef<AudioCapture | null>(null);
  const flush = useRef<() => Promise<void>>(async () => {});
  const stopping = useRef(false);
  const live = useSession();
  const recording = meeting.status === "recording";
  // Notes are generated in the main process after Stop, whichever window stopped.
  const processing =
    generating ||
    (live.meetingId === meeting.id &&
      (live.phase === "stopping" || live.phase === "processing"));
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["meeting", meeting.id] });
    await client.invalidateQueries({ queryKey: ["meetings"] });
  };
  useEffect(() => {
    const off = api.onTranscript((event: TranscriptionEvent) => {
      if (event.type === "partial") setPartial(event.text);
      if (event.type === "final") {
        setPartial("");
        void client.invalidateQueries({ queryKey: ["meeting", meeting.id] });
      }
      if (event.type === "connection") {
        setConnection(event.status);
        if (
          event.message &&
          (event.status === "reconnecting" || event.status === "failed")
        )
          setError(event.message);
        if (event.status === "closed") setPartial("");
      }
    });
    return off;
  }, [meeting.id, client]);
  // Stop pressed in the floating window or tray: this window owns the microphone.
  const stopRef = useRef<() => Promise<void>>(async () => {});
  useEffect(
    () =>
      api.onCaptureRelease((id) => {
        if (id === meeting.id) void stopRef.current();
      }),
    [meeting.id],
  );
  useEffect(() => {
    if (!recording || !meeting.startedAt) return;
    const tick = () =>
      setElapsed(
        Math.floor((Date.now() - Date.parse(meeting.startedAt!)) / 1000),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [recording, meeting.startedAt]);
  useEffect(
    () => () => {
      const current = capture.current;
      if (current) {
        void current
          .stop()
          .then(() => api.stop(meeting.id))
          .catch(() => {});
        capture.current = null;
        useNavigation.getState().setCapture(false);
      }
    },
    [meeting.id],
  );
  async function start() {
    setBusy(true);
    setError("");
    const audio = new AudioCapture();
    capture.current = audio;
    nav.setCapture(true);
    try {
      await flush.current();
      const sampleRate = audio.prepare();
      await api.start({ id: meeting.id, sampleRate, systemAudio: useSystem });
      await refresh();
      await audio.start(
        useSystem,
        (data) => api.audio({ id: meeting.id, data }),
        setLevel,
        (source, connected) => {
          if (source === "microphone") setMic(connected);
          else setSystem(connected);
          api.captureSource({ id: meeting.id, source, connected });
        },
        setError,
      );
    } catch (e) {
      await audio.stop();
      capture.current = null;
      nav.setCapture(false);
      await api.stop(meeting.id).catch(() => {});
      setError(
        `Capture could not start. ${errorMessage(e)} Check microphone permission and provider settings.`,
      );
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function generate() {
    setGenerating(true);
    setError("");
    try {
      await flush.current();
      await api.generate(meeting.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      await refresh();
    } finally {
      setGenerating(false);
    }
  }
  async function stop() {
    if (stopping.current) return;
    stopping.current = true;
    setBusy(true);
    setError("");
    const audio = capture.current;
    capture.current = null;
    try {
      // Notes are saved before the main process starts generating from them.
      await flush.current().catch(() => {});
      await audio?.stop();
    } finally {
      setMic(false);
      setSystem(false);
      setLevel(0);
      nav.setCapture(false);
    }
    try {
      await api.stop(meeting.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      await refresh();
    } finally {
      setBusy(false);
      stopping.current = false;
    }
  }
  stopRef.current = stop;
  return (
    <>
      <div className={`meeting-heading ${recording ? "is-recording" : ""}`}>
        <div>
          <p className="eyebrow">
            {templates[meeting.template].name.toUpperCase()}
          </p>
          <h1>{meeting.title}</h1>
          <div className="meeting-meta">
            <span>
              {new Date(meeting.createdAt).toLocaleDateString(undefined, {
                weekday: "short",
                month: "long",
                day: "numeric",
              })}
            </span>
            <span>
              <Clock size={12} />
              {time(recording ? elapsed : meeting.durationSeconds)}
            </span>
          </div>
        </div>
        {recording ? (
          <div className="recording-controls">
            <span className="recording-badge">
              <i /> RECORDING · {time(elapsed)}
            </span>
            <button
              className="stop-button"
              disabled={busy}
              onClick={() => void stop()}
            >
              <Square size={12} fill="currentColor" /> Stop Meeting
            </button>
          </div>
        ) : (
          <span className={`status-pill ${meeting.status}`}>
            {meeting.status}
          </span>
        )}
      </div>
      {(error || meeting.error) && (
        <div role="alert" className="error-banner">
          {error || meeting.error}
        </div>
      )}
      {meeting.status === "draft" && (
        <div className="preflight">
          <div className="preflight-icon">
            <ShieldCheck size={23} />
          </div>
          <div>
            <h2>Be present. Let everyone know.</h2>
            <p>
              Please make sure everyone in the meeting knows that transcription
              is being used and that your use complies with applicable law and
              organizational policy.
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={useSystem}
                disabled={!info.systemAudioSupported || busy}
                onChange={(e) => setUseSystem(e.target.checked)}
              />{" "}
              Include computer audio{" "}
              {info.systemAudioSupported
                ? "(OS sharing prompt may appear)"
                : "— not available on this OS"}
            </label>
          </div>
          <button disabled={busy} onClick={() => void start()}>
            <Mic size={16} />
            {busy ? "Connecting…" : "Start Meeting"}
          </button>
        </div>
      )}
      {meeting.summary && <IntelligenceView meeting={meeting} />}
      <div className={`live-layout ${transcriptOpen ? "" : "collapsed"}`}>
        <NotesEditor
          meeting={meeting}
          onFlush={(fn) => {
            flush.current = fn;
          }}
        />
        <div className="transcript-panel">
          <button
            className="transcript-title"
            onClick={() => setTranscriptOpen(!transcriptOpen)}
          >
            <Radio size={16} /> Live Transcript{" "}
            {transcriptOpen ? (
              <ChevronDown size={15} />
            ) : (
              <ChevronRight size={15} />
            )}
          </button>
          {transcriptOpen && (
            <div className="transcript-content">
              {meeting.segments.length === 0 && !partial && (
                <div className="transcript-empty">
                  <Radio size={24} />
                  <p>
                    {recording
                      ? "Listening for the conversation…"
                      : "The conversation will appear here once you start."}
                  </p>
                  <span>Your notes are always separate.</span>
                </div>
              )}
              {meeting.segments.map((s) => (
                <article
                  className="transcript-segment"
                  id={`segment-${s.id}`}
                  key={s.id}
                >
                  <div>
                    <strong>{s.speaker}</strong>
                    <time>{time(s.startTimeMs / 1000)}</time>
                  </div>
                  <p>{s.text}</p>
                </article>
              ))}
              {partial && (
                <p className="partial-transcript">
                  {partial}
                  <span> · transcribing</span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <footer className="capture-status">
        <span className={mic ? "connected" : ""}>
          <Mic size={13} /> Microphone: {mic ? "Connected" : "Not available"}
        </span>
        <span className={system ? "connected" : ""}>
          <Monitor size={13} /> System audio:{" "}
          {system ? "Connected" : "Not available"}
        </span>
        <span>
          <Radio size={13} /> {connection}
        </span>
        <div className="audio-meter" aria-label="Audio level">
          <div style={{ width: `${Math.min(100, level * 350)}%` }} />
        </div>
      </footer>
      {(meeting.status === "processing" || meeting.status === "failed") && (
        <div className="processing-panel">
          <h2>
            {processing
              ? "Turning your conversation into clarity…"
              : "Your notes and transcript are saved."}
          </h2>
          <p>
            {processing
              ? "Extracting facts, checking sources, and shaping your enhanced notes."
              : "Generate intelligence from the saved meeting without recording again."}
          </p>
          <button disabled={processing || busy} onClick={() => void generate()}>
            {processing ? "Generating…" : "Retry intelligence"}
          </button>
        </div>
      )}
      <button
        className="text-button danger-text delete-meeting"
        disabled={recording || busy || processing}
        onClick={async () => {
          if (
            !window.confirm(
              "Permanently delete this meeting, notes, transcript, actions and chat?",
            )
          )
            return;
          try {
            await flush.current();
            await api.delete(meeting.id);
            clearDraft(meeting.id);
            nav.open(null);
            client.removeQueries({ queryKey: ["meeting", meeting.id] });
            await client.invalidateQueries({ queryKey: ["meetings"] });
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <Trash2 size={13} /> Delete meeting
      </button>
    </>
  );
}
