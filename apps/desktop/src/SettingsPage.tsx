import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck,
  Mic,
  Monitor,
  RefreshCw,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import { api } from "./api";
import { AIConfiguration } from "./AIConfiguration";
import { clearAllDrafts } from "./notes";
import {
  templates,
  type AppInfo,
  type Settings,
  type Template,
} from "../../../packages/shared";
export function SettingsPage({ info }: { info: AppInfo }) {
  const client = useQueryClient();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  async function update(patch: Partial<Settings>) {
    setBusy(true);
    setError("");
    try {
      await api.settings({ ...info.settings, ...patch });
      await client.invalidateQueries();
      setNotice("Settings saved.");
    } catch {
      setError(
        "Settings could not be saved. Finish any active meeting or AI request, then retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MAKE YOURSELF AT HOME</span>
          <h1>Your workspace, your rules.</h1>
          <p className="muted">
            A few thoughtful defaults. You stay in control.
          </p>
        </div>
      </div>
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
      <div className="settings-section">
        <h2>Profile</h2>
        <div className="setting-row">
          <div>
            <strong>Your private workspace</strong>
            <p>
              Local development identity ·{" "}
              {info.mode === "local"
                ? "stored on this device"
                : "connected to your PostgreSQL database"}
            </p>
          </div>
          <span className="status-pill">Development mode</span>
        </div>
        <p className="settings-note">
          This MVP uses a local identity. Hosted sign-in and multi-device sync
          are not enabled.
        </p>
      </div>
      <AIConfiguration info={info} />
      <div className="settings-section">
        <h2>Meetings</h2>
        <div className="setting-row">
          <div>
            <strong>Default meeting template</strong>
            <p>A starting point for new conversations.</p>
          </div>
          <select
            aria-label="Default meeting template"
            disabled={busy}
            value={info.settings.defaultTemplate}
            onChange={(e) =>
              void update({ defaultTemplate: e.target.value as Template })
            }
          >
            {Object.entries(templates).map(([key, t]) => (
              <option key={key} value={key}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Compact meeting window</strong>
            <p>
              When recording starts, hide RecallFlow and keep a small
              always-on-top control. Hiding either window never stops a meeting.
            </p>
          </div>
          <input
            type="checkbox"
            aria-label="Compact meeting window"
            disabled={busy}
            checked={info.settings.compactOnStart}
            onChange={(e) => void update({ compactOnStart: e.target.checked })}
          />
        </div>
      </div>
      <div className="settings-section">
        <h2>Audio permissions</h2>
        <div className="setting-row">
          <div>
            <strong>
              <Mic size={14} /> Microphone
            </strong>
            <p>
              {info.microphonePermission}. Permission is requested only after
              Start Meeting.
            </p>
          </div>
          <button
            className="secondary"
            onClick={() =>
              void client.invalidateQueries({ queryKey: ["info"] })
            }
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>
              <Monitor size={14} /> System audio
            </strong>
            <p>
              {info.systemAudioSupported
                ? "Available to request. Actual capture depends on OS support and the shared source."
                : "Not available on this OS. Microphone capture is supported."}
            </p>
          </div>
        </div>
      </div>
      <div className="settings-section">
        <h2>Privacy & retention</h2>
        <div className="privacy-statement">
          <ShieldCheck size={21} />
          <p>
            Recording starts only when you choose. No meeting bots, no
            permanently stored raw audio, and no training on meeting data by
            RecallFlow. Transcription and AI providers process data only when
            configured.
          </p>
        </div>
        <div className="setting-row">
          <div>
            <strong>Transcript retention</strong>
            <p>
              Remove original transcript segments after this period. Personal
              notes and generated intelligence remain.
            </p>
          </div>
          <select
            aria-label="Transcript retention"
            disabled={busy}
            value={info.settings.transcriptRetentionDays ?? "forever"}
            onChange={(e) =>
              void update({
                transcriptRetentionDays:
                  e.target.value === "forever" ? null : Number(e.target.value),
              })
            }
          >
            <option value="forever">Until I delete it</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
          </select>
        </div>
        <p className="settings-note">
          Retention runs at launch and when this setting changes. Expired
          transcript sources are removed from citations. To remove all meeting
          content, delete the meeting.
        </p>
        <div className="setting-row">
          <div>
            <strong>Delete all meetings</strong>
            <p>
              Permanently delete meetings, notes, transcripts, summaries,
              actions, participants, chat, and local note recovery.
            </p>
          </div>
          <button
            className="secondary danger-text"
            onClick={() => setConfirm(true)}
          >
            <Trash2 size={13} /> Delete all
          </button>
        </div>
      </div>
      {info.development && (
        <div className="settings-section">
          <h2>Developer settings</h2>
          <p className="settings-note">
            Configure APP_MODE, DATABASE_URL, TRANSCRIPTION_PROVIDER,
            AI_PROVIDER, WHISPER_* and OLLAMA_* in .env. Mock providers remain
            visibly labelled throughout the app. Use npm run db:seed for an
            explicitly labelled sample meeting.
          </p>
        </div>
      )}
      {confirm && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.deleteAll();
                clearAllDrafts();
                client.clear();
                setConfirm(false);
                setConfirmation("");
                setNotice("All meetings and local recovery drafts deleted.");
              } catch {
                setError(
                  "Deletion failed. Stop active meetings and wait for AI requests to finish, then retry.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <h2>Delete every meeting?</h2>
            <p className="muted small">
              This removes all associated data from this workspace and cannot be
              undone. Type DELETE to continue.
            </p>
            <label>
              Confirmation
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="stop-button"
                disabled={busy || confirmation !== "DELETE"}
              >
                {busy ? "Deleting…" : "Delete all meetings"}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
