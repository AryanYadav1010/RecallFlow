# RecallFlow architecture

RecallFlow is a single-user desktop companion. The renderer never receives provider keys, database credentials, filesystem primitives, or arbitrary IPC access.

- `apps/desktop/electron`: trusted composition root, validated IPC, permissions, capture session ownership.
- `apps/desktop/src`: React UI, browser audio capture, notes editor, local recovery.
- `packages/shared`: Zod contracts, lifecycle rules, templates, export.
- `packages/database`: user-scoped repository interface, atomic local adapter, Prisma PostgreSQL adapter.
- `packages/transcription`: streaming provider contract, Deepgram, Local Whisper (`whisper.ts`, whisper.cpp server on localhost), explicit mock.
- `packages/ai`: normalized context, structured extraction, separate presentation, evidence validation, grounded chat. `StructuredAIProvider` holds the prompts; OpenAI/Anthropic (`RemoteAIProvider`) and Ollama (`ollama.ts`) implement one structured call each.
- `packages/core`: meeting orchestration, serial writes, recoverable notes, lifecycle. `session.ts` owns the live meeting (`MeetingSession`); `providers.ts` builds providers, reports readiness and computes Local Mode; `config.ts` resolves configuration.
- `apps/desktop/src/floating.tsx`: the floating meeting window, a view of the session with its own minimal preload.

The Electron main process owns services and secrets. `MeetingSession` is the single owner of the live meeting and pushes one `SessionState` to the main window, the floating window and the tray; windows send commands and never own recording. Capture stays in the main window's renderer (Chromium media APIs), so that window is hidden rather than destroyed during a meeting, and a Stop from elsewhere asks it to release the microphone first. See [ADR 0001](docs/adr/0001-compact-meeting-mode-and-local-ai.md). AudioWorklet converts microphone/system audio into mono PCM16; chunks cross a narrow IPC boundary and stream to the transcription provider. Only finalized transcript segments are persisted. Audio exists only in bounded memory queues and is discarded after transmission. Stop releases browser tracks immediately, drains transcription, and then generates intelligence.

Notes have independent storage and are never replaced by AI output. Renderer recovery persists on each edit; main-process recovery is atomically written before repository persistence. Meeting writes are serialized so notes, finalized segments, and summaries cannot overwrite one another. Interrupted recordings become failed/recoverable on next launch.

The PostgreSQL schema intentionally uses normalized entities. Search uses PostgreSQL full-text expressions with GIN indexes, scoped by the local installation's user ID. A future authenticated service must derive user identity from verified sessions, enforce authorization server-side, and remove database credentials from distributed clients. The present database mode is a trusted developer deployment, not a multi-tenant hosted product.

Provider extraction and presentation are separate calls. Validated structured extraction remains stored alongside enhanced notes. Citations are filtered against known segment IDs. Model instructions treat meeting content as untrusted data; no model output triggers tools or actions.
