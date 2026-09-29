import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import type { Meeting } from "../../../packages/shared";
import { api } from "./api";
import { useNotes } from "./notes";
export function NotesEditor({
  meeting,
  onFlush,
}: {
  meeting: Meeting;
  onFlush?: (flush: () => Promise<void>) => void;
}) {
  const notes = useNotes(meeting.id, meeting.notes, (id, content) =>
    api.saveNotes({ id, content }),
  );
  if (onFlush) onFlush(notes.flush);
  const append = useRef(notes.append);
  append.current = notes.append;
  useEffect(
    () =>
      api.onQuickNote(({ meetingId, text }) => {
        if (meetingId === meeting.id) append.current(`• ${text}`);
      }),
    [meeting.id],
  );
  return (
    <div className="notes-editor">
      <div className="section-heading">
        <h2>My Notes</h2>
        <span
          className={`save-state ${notes.status === "error" || notes.status === "unsafe" ? "danger-text" : ""}`}
        >
          {notes.status === "saved" ? (
            <>
              <Check size={13} /> All changes saved
            </>
          ) : notes.status === "error" ? (
            "Save failed · recovery kept"
          ) : notes.status === "unsafe" ? (
            "Recovery unavailable · copy notes now"
          ) : notes.status === "recovered" ? (
            "Recovered unsaved notes"
          ) : (
            "Saving…"
          )}
        </span>
      </div>
      <p className="editor-caption">
        Your thoughts, in your own words. These help shape your meeting notes.
      </p>
      <textarea
        aria-label="My Notes"
        placeholder={
          "What’s worth remembering?\n\nWrite freely. We’ll take care of the transcript."
        }
        value={notes.content}
        onChange={(e) => notes.change(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            const pos = e.currentTarget.selectionStart;
            notes.change(
              notes.content.slice(0, pos) + "\n★ " + notes.content.slice(pos),
            );
          }
        }}
      />
      <div className="editor-hint">
        <span>Private notes · saved independently</span>
        <span>
          <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> to mark important
        </span>
      </div>
      {(notes.status === "error" || notes.status === "unsafe") && (
        <button
          className="secondary"
          onClick={() => void notes.flush().catch(() => {})}
        >
          Retry saving notes
        </button>
      )}
    </div>
  );
}
