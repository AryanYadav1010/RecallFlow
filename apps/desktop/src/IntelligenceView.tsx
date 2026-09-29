import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Sparkles,
  X,
  Users,
  MessageSquare,
  Send,
} from "lucide-react";
import { markdown, type Meeting } from "../../../packages/shared";
import { api } from "./api";
import { time } from "./MeetingPage";
function Prose({ text }: { text: string }) {
  return (
    <div className="prose">
      {text.split("\n").map((line, i) =>
        line.startsWith("## ") ? (
          <h3 key={i}>{line.slice(3)}</h3>
        ) : line.startsWith("# ") ? (
          <h3 key={i}>{line.slice(2)}</h3>
        ) : line.startsWith("- ") ? (
          <p className="prose-bullet" key={i}>
            • {line.slice(2)}
          </p>
        ) : line.trim() ? (
          <p key={i}>{line}</p>
        ) : (
          <div key={i} className="prose-gap" />
        ),
      )}
    </div>
  );
}
export function IntelligenceView({ meeting }: { meeting: Meeting }) {
  const client = useQueryClient();
  const summary = meeting.summary;
  const [source, setSource] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const Source = ({ ids }: { ids: string[] }) =>
    ids.some((id) => meeting.segments.some((s) => s.id === id)) ? (
      <button className="source-link" onClick={() => setSource(ids)}>
        <ExternalLink size={11} /> View source
      </button>
    ) : (
      <span className="no-source">No transcript source available</span>
    );
  const refresh = () =>
    client.invalidateQueries({ queryKey: ["meeting", meeting.id] });
  async function ask(value: string) {
    if (!value.trim() || asking) return;
    setAsking(true);
    setError("");
    try {
      await api.chat({ id: meeting.id, question: value });
      setQuestion("");
      await refresh();
    } catch {
      setError(
        "Could not answer. Your question is saved; check the provider and retry.",
      );
      await refresh();
    } finally {
      setAsking(false);
    }
  }
  if (!summary) return null;
  const x = summary.extraction;
  return (
    <>
      <div className="result-toolbar">
        <span>
          <Sparkles size={14} /> Meeting intelligence{" "}
          <span className="muted small">· Review before sharing</span>
        </span>
        <div>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(markdown(meeting));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                setError("Clipboard unavailable. Try Export Markdown.");
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}{" "}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            className="secondary"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([markdown(meeting)], {
                  type: "text/markdown;charset=utf-8",
                }),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download =
                meeting.title.replace(/[^a-z0-9 -]/gi, "").slice(0, 100) +
                ".md";
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={13} /> Export Markdown
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <div className="participants">
        <Users size={13} />
        {x.participants.length
          ? x.participants.join(" · ")
          : "Participants not explicitly identified"}
      </div>
      <div className="summary-layout">
        <div className="summary-main">
          <section className="intelligence-section overview-section">
            <span className="eyebrow">THE BIG PICTURE</span>
            <h2>Overview</h2>
            <p className="overview-text">
              {summary.overview ||
                "Presentation is not available yet. Retry intelligence below."}
            </p>
          </section>
          <section className="intelligence-section">
            <h2>Key Topics</h2>
            {x.topics.length ? (
              <div className="topic-grid">
                {x.topics.map((t, i) => (
                  <div className="topic-card" key={i}>
                    <h3>{t.name}</h3>
                    <p>{t.summary}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">No topics extracted.</p>
            )}
          </section>
          <section className="intelligence-section">
            <h2>Decisions</h2>
            {x.decisions.length ? (
              x.decisions.map((d, i) => (
                <div className="evidence-row" key={i}>
                  <span className="decision-check">
                    <Check size={13} />
                  </span>
                  <div>
                    <p>{d.text}</p>
                    <Source ids={d.evidenceSegmentIds} />
                  </div>
                </div>
              ))
            ) : (
              <p className="muted small">No explicit decisions captured.</p>
            )}
          </section>
          <section className="intelligence-section">
            <div className="section-heading">
              <h2>Action Items</h2>
              <span className="count-label">
                {meeting.actions.filter((a) => a.status === "done").length} of{" "}
                {meeting.actions.length} complete
              </span>
            </div>
            {meeting.actions.length ? (
              meeting.actions.map((a) => (
                <div
                  className={`action-row ${a.status === "done" ? "done" : ""}`}
                  key={a.id}
                >
                  <input
                    type="checkbox"
                    aria-label={`Complete: ${a.description}`}
                    checked={a.status === "done"}
                    onChange={async (e) => {
                      try {
                        await api.action({
                          id: meeting.id,
                          actionId: a.id,
                          done: e.target.checked,
                        });
                        await refresh();
                      } catch {
                        setError("Action could not be saved. Please retry.");
                      }
                    }}
                  />
                  <div>
                    <p>{a.description}</p>
                    <div className="action-meta">
                      <span>{a.owner ?? "Owner not stated"}</span>
                      <span>{a.dueDate ?? "No due date stated"}</span>
                      <Source ids={a.evidenceSegmentIds} />
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted small">No explicit commitments captured.</p>
            )}
          </section>
          <div className="split-sections">
            <section className="intelligence-section">
              <h2>Questions / Follow-ups</h2>
              {x.questions.length ? (
                x.questions.map((q, i) => (
                  <p className="list-item" key={i}>
                    {q}
                  </p>
                ))
              ) : (
                <p className="muted small">None captured.</p>
              )}
            </section>
            <section className="intelligence-section">
              <h2>Risks / Blockers</h2>
              {x.risks.length ? (
                x.risks.map((r, i) => (
                  <p className="list-item" key={i}>
                    {r}
                  </p>
                ))
              ) : (
                <p className="muted small">None captured.</p>
              )}
            </section>
          </div>
          <section className="intelligence-section">
            <h2>Important Facts</h2>
            {x.importantFacts.length ? (
              x.importantFacts.map((f, i) => (
                <div className="fact-row" key={i}>
                  <p>{f.text}</p>
                  <Source ids={f.evidenceSegmentIds} />
                </div>
              ))
            ) : (
              <p className="muted small">
                No explicit numbers or dates extracted.
              </p>
            )}
          </section>
          <section className="intelligence-section">
            <h2>Enhanced Notes</h2>
            <Prose text={summary.detailedNotes} />
          </section>
          <section className="intelligence-section follow-up">
            <h2>Suggested Follow-up Message</h2>
            <p className="small muted">A draft for you to review and send.</p>
            <Prose text={summary.suggestedFollowUp} />
          </section>
        </div>
        <aside className="chat-panel">
          <div className="chat-heading">
            <MessageSquare size={17} />
            <h2>Ask this meeting</h2>
          </div>
          <p className="chat-caption">Get back to the details, with context.</p>
          <div className="chat-messages">
            {!meeting.chat.length && (
              <>
                <div className="chat-welcome">
                  <Sparkles size={24} />
                  <p>
                    A second look at
                    <br />
                    the conversation.
                  </p>
                </div>
                {[
                  "What did we decide?",
                  "What should I follow up on?",
                  "What information is missing?",
                ].map((q) => (
                  <button
                    className="chat-suggestion"
                    key={q}
                    disabled={asking}
                    onClick={() => void ask(q)}
                  >
                    {q}
                    <Send size={11} />
                  </button>
                ))}
              </>
            )}
            {meeting.chat.map((c) => (
              <article key={c.id} className={`chat-message ${c.role}`}>
                <div>
                  {c.role === "user"
                    ? "You"
                    : c.kind === "inference"
                      ? "Inference"
                      : c.kind === "unavailable"
                        ? "Not in this meeting"
                        : "From your meeting"}
                </div>
                <p>{c.content}</p>
                {!!c.evidenceSegmentIds?.length && (
                  <Source ids={c.evidenceSegmentIds} />
                )}
              </article>
            ))}
            {asking && (
              <p className="muted small">Reviewing the conversation…</p>
            )}
          </div>
          <form
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <input
              aria-label="Ask this meeting"
              value={question}
              maxLength={4000}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question…"
            />
            <button
              type="submit"
              aria-label="Send question"
              disabled={asking || !question.trim()}
            >
              <Send size={15} />
            </button>
          </form>
          <p className="chat-disclaimer">
            Answers may be incomplete. Check the sources.
          </p>
        </aside>
      </div>
      {source && (
        <div className="modal-backdrop" onClick={() => setSource(null)}>
          <div
            className="source-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Transcript sources"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              aria-label="Close source"
              className="icon-button close"
              onClick={() => setSource(null)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">FROM THE CONVERSATION</span>
            <h2>Supporting transcript</h2>
            <p className="muted small">
              Original transcript excerpts, unchanged.
            </p>
            {meeting.segments
              .filter((s) => source.includes(s.id))
              .map((s) => (
                <article className="source-excerpt" key={s.id}>
                  <div>
                    {s.speaker}
                    <span>{time(s.startTimeMs / 1000)}</span>
                  </div>
                  <p>{s.text}</p>
                </article>
              ))}
          </div>
        </div>
      )}
    </>
  );
}
