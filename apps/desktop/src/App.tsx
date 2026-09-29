import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Search,
  Settings,
  NotebookPen,
  LayoutTemplate,
  ArrowLeft,
  ShieldCheck,
  ChevronRight,
  Leaf,
  Clock,
  MoreHorizontal,
  Check,
  X,
} from "lucide-react";
import { api, errorMessage } from "./api";
import { SettingsPage } from "./SettingsPage";
import { MeetingPage } from "./MeetingPage";
import {
  templates,
  type SessionState,
  type Template,
} from "../../../packages/shared";
import { useNavigation, useSession } from "./state";
const providerNames: Record<string, string> = {
  whisper: "Local Whisper",
  deepgram: "Deepgram",
  ollama: "Ollama",
  openai: "OpenAI",
  anthropic: "Anthropic",
};
export function App() {
  const nav = useNavigation();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<Template>("general");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const info = useQuery({ queryKey: ["info"], queryFn: api.info });
  const meetings = useQuery({
    queryKey: ["meetings", query],
    queryFn: () => api.list(query),
  });
  const selected = useQuery({
    queryKey: ["meeting", nav.meetingId],
    queryFn: () => api.get(nav.meetingId!),
    enabled: !!nav.meetingId,
  });
  useEffect(() => {
    const apply = (state: SessionState) => {
      const previous = useSession.getState().phase;
      useSession.setState(state, true);
      if (state.phase !== previous) void client.invalidateQueries();
    };
    void api.session().then(apply);
    const offSession = api.onSession(apply);
    const offOpen = api.onOpenMeeting((id) => {
      useNavigation.getState().setPage("Meetings");
      useNavigation.getState().open(id);
    });
    return () => {
      offSession();
      offOpen();
    };
  }, [client]);
  const localMode =
    info.data?.localMode.active && !info.data.localMode.caveats.length;
  const createMeeting = async () => {
    setBusy(true);
    setError("");
    try {
      const m = await api.create({ title, template });
      setCreating(false);
      setTitle("");
      await client.invalidateQueries({ queryKey: ["meetings"] });
      nav.open(m.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Leaf size={22} />
          </span>
          RecallFlow<span className="beta">BETA</span>
        </div>
        <button
          className="new-meeting"
          disabled={nav.captureActive}
          onClick={() => {
            setTemplate(info.data?.settings.defaultTemplate ?? "general");
            setCreating(true);
          }}
        >
          <Plus size={17} /> New Meeting <kbd>＋</kbd>
        </button>
        <div className="nav-group">WORKSPACE</div>
        <nav>
          {[
            { name: "Meetings", icon: NotebookPen },
            { name: "Search", icon: Search },
            { name: "Templates", icon: LayoutTemplate },
            { name: "Settings", icon: Settings },
          ].map(({ name, icon: Icon }) => (
            <button
              key={name}
              disabled={nav.captureActive}
              className={nav.page === name && !nav.meetingId ? "active" : ""}
              onClick={() => nav.setPage(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Meetings" && (
                <span className="nav-count">{meetings.data?.length ?? 0}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <ShieldCheck size={19} />
            <strong>A space for your thoughts</strong>
            <p>
              No meeting bots. No stored audio.
              <br />
              Just you and your notes.
            </p>
          </div>
          <div className="profile">
            <div className="avatar">Y</div>
            <div>
              <strong>Your workspace</strong>
              <span>
                {info.data?.mode === "database"
                  ? "Private database"
                  : "Local development"}
              </span>
            </div>
            <MoreHorizontal size={16} />
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            {nav.meetingId ? (
              <button
                className="text-button"
                disabled={nav.captureActive}
                onClick={() => nav.open(null)}
              >
                <ArrowLeft size={15} /> Meetings
              </button>
            ) : (
              nav.page
            )}
          </span>
          {localMode ? (
            <span
              className="private-label local-mode"
              title="Transcription and meeting intelligence are processed locally on this device."
            >
              <ShieldCheck size={13} /> Local Mode
            </span>
          ) : (
            <span className="private-label">
              <ShieldCheck size={13} /> Private workspace
            </span>
          )}
        </header>
        <div className="content">
          {(error || meetings.error || selected.error) && (
            <div className="error-banner" role="alert">
              {error || String(meetings.error || selected.error)}
              <button
                onClick={() => {
                  setError("");
                  void client.invalidateQueries();
                }}
              >
                Retry
              </button>
            </div>
          )}
          {info.data &&
            (info.data.ai === "mock" || info.data.transcription === "mock") && (
              <div className="mock-banner">
                Development providers ·{" "}
                {info.data.transcription === "mock"
                  ? "transcription uses scripted sample text"
                  : `${providerNames[info.data.transcription]} transcription`}{" "}
                ·{" "}
                {info.data.ai === "mock"
                  ? "AI output is a deterministic preview"
                  : `${providerNames[info.data.ai]} meeting intelligence`}
              </div>
            )}
          {nav.meetingId ? (
            selected.data ? (
              info.data ? (
                <MeetingPage
                  key={selected.data.id}
                  meeting={selected.data}
                  info={info.data}
                />
              ) : (
                <p>Loading settings…</p>
              )
            ) : (
              <p>Loading meeting…</p>
            )
          ) : nav.page === "Templates" ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">A LITTLE STRUCTURE</p>
                  <h1>A format for every conversation.</h1>
                  <p className="muted">
                    Templates shape your enhanced notes. Your original words
                    stay yours.
                  </p>
                </div>
              </div>
              <div className="template-grid">
                {Object.entries(templates).map(([id, t]) => (
                  <button
                    className="template-card"
                    key={id}
                    onClick={() => {
                      setTemplate(id as Template);
                      setCreating(true);
                    }}
                  >
                    <LayoutTemplate size={25} />
                    <h2>{t.name}</h2>
                    <p>{t.sections.join(" · ")}</p>
                    <span>
                      Use template <ChevronRight size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : nav.page === "Settings" ? (
            info.data ? (
              <SettingsPage info={info.data} />
            ) : (
              <p>Loading settings…</p>
            )
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">MAKE ROOM FOR THE CONVERSATION</p>
                  <h1>
                    {nav.page === "Search"
                      ? "Find that important detail."
                      : "A little more present."}
                  </h1>
                  <p className="muted">
                    {nav.page === "Search"
                      ? "Search across meeting titles, notes, summaries and transcripts."
                      : "Your meetings, thoughtfully remembered."}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setTemplate(
                      info.data?.settings.defaultTemplate ?? "general",
                    );
                    setCreating(true);
                  }}
                >
                  <Plus size={16} /> New Meeting
                </button>
              </div>
              <div className="search-box">
                <Search size={17} />
                <input
                  aria-label="Search meetings"
                  placeholder="Search your meetings, notes, and ideas…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span>All meetings</span>
              </div>
              <div className="list-heading">
                <h2>
                  {query ? "Search results" : "Today & previous meetings"}
                </h2>
                <span>
                  {meetings.data?.length ?? 0} meetings{" "}
                  <MoreHorizontal size={18} />
                </span>
              </div>
              {meetings.isLoading ? (
                <p>Loading your workspace…</p>
              ) : !meetings.data?.length ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <NotebookPen size={34} strokeWidth={1.3} />
                  </div>
                  <h2>
                    {query
                      ? "Nothing here just yet."
                      : "Good conversations deserve good notes."}
                  </h2>
                  <p>
                    {query
                      ? "Try another word from your meeting."
                      : "Start a meeting, stay in the moment, and leave with a clear next step."}
                  </p>
                  {!query && (
                    <button
                      onClick={() => {
                        setTemplate(
                          info.data?.settings.defaultTemplate ?? "general",
                        );
                        setCreating(true);
                      }}
                    >
                      <Plus size={16} /> Create your first meeting
                    </button>
                  )}
                  <div className="empty-features">
                    <span>
                      <Check size={14} /> Live transcription
                    </span>
                    <span>
                      <Check size={14} /> Your personal notes
                    </span>
                    <span>
                      <Check size={14} /> Clear next steps
                    </span>
                  </div>
                </div>
              ) : (
                <div className="meeting-list">
                  {meetings.data.map((m) => (
                    <button
                      className="meeting-card"
                      key={m.id}
                      onClick={() => nav.open(m.id)}
                    >
                      <div className="meeting-card-icon">
                        <NotebookPen size={21} />
                      </div>
                      <div className="meeting-card-main">
                        <div>
                          <h3>{m.title}</h3>
                          <span className={`status-pill ${m.status}`}>
                            {m.status}
                          </span>
                        </div>
                        <p>
                          {m.summary?.overview ||
                            m.notes ||
                            "Your next conversation starts here."}
                        </p>
                        <div className="meeting-meta">
                          <span>
                            {new Date(m.createdAt).toLocaleDateString(
                              undefined,
                              { month: "short", day: "numeric" },
                            )}
                          </span>
                          <span>
                            <Clock size={12} />
                            {Math.floor(m.durationSeconds / 60)} min
                          </span>
                          <span>{templates[m.template].name}</span>
                          {m.actions.length > 0 && (
                            <span>
                              {
                                m.actions.filter((a) => a.status === "open")
                                  .length
                              }{" "}
                              open actions
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                </div>
              )}
              <div className="workspace-footer">
                <Leaf size={14} /> Less remembering. More being there.
              </div>
            </>
          )}
        </div>
      </div>
      {creating && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void createMeeting();
            }}
          >
            <button
              type="button"
              aria-label="Close"
              className="icon-button close"
              onClick={() => setCreating(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">A FRESH PAGE</span>
            <h2>What’s the conversation?</h2>
            <label>
              Meeting title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                required
                placeholder="e.g. Monday product sync"
              />
            </label>
            <label>
              Note template
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value as Template)}
              >
                {Object.entries(templates).map(([id, t]) => (
                  <option value={id} key={id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">
              You’ll review audio settings before recording starts.
            </p>
            {error && (
              <p role="alert" className="danger-text">
                {error}
              </p>
            )}
            <button disabled={busy || !title.trim()} type="submit">
              {busy ? "Creating…" : "Create meeting"}
              <ChevronRight size={16} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
