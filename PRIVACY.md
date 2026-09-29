# Privacy and security

## Capture and consent

RecallFlow is a visible local desktop companion, not a meeting bot. It never joins calls. Audio capture is initiated only by the Start Meeting button. Every meeting has a pre-capture reminder:

> Please make sure everyone in the meeting knows that transcription is being used and that your use complies with applicable law and organizational policy.

A red recording label and timer remain visible during capture: in the main window, in the always-on-top floating meeting controls, and in the tray/menu-bar icon. Navigation away is disabled while recording. Closing or hiding the main window during a meeting only hides it; the floating controls stay visible, so recording is never hidden from the user. Stop (from either window or the tray) releases microphone and display-media tracks immediately, before provider finalization or AI generation. Quitting during a meeting asks for explicit confirmation. Operating-system permission remains required. There are no stealth recording mechanisms or background auto-start tasks.

## What leaves the machine

- With **Local Whisper**, audio is sent only to a `whisper-server` child process bound to `127.0.0.1` on this device. Nothing is sent over the network for transcription.
- With **Ollama**, transcript text, notes and meeting context are sent to the configured Ollama host. The default is `http://127.0.0.1:11434` (this device). If `OLLAMA_HOST` points at another machine, data leaves this device and the app does not show "Local Mode".
- "Local Mode" is shown only when both of the above are selected and Ollama is on a loopback address. Settings lists anything else that still moves meeting data off the device, such as a remote PostgreSQL database.
- With Deepgram configured, mono PCM audio streams over TLS to Deepgram. Requests set `mip_opt_out=true` to opt out of its model improvement program.
- With OpenAI or Anthropic configured, transcript text, personal notes, and meeting context are sent for extraction, presentation, or a user-requested chat answer.
- Mock providers do not send meeting data to an AI/transcription service. Mock transcription is scripted data, not speech recognition.
- Database mode sends stored meeting entities to the configured PostgreSQL server; choose a deployment and SSL settings appropriate for your organization.

RecallFlow does not train models on meeting data, include telemetry, send data to other users, or opt into provider training. Provider retention and organizational account settings are outside this application. Configure commercial API accounts consistently with your obligations; do not opt into provider data-sharing/training programs. Provider processing is not the same as zero retention.

References: [Deepgram streaming and model-improvement opt-out](https://developers.deepgram.com/reference/speech-to-text/listen-streaming), [OpenAI business data policy](https://openai.com/business-data/), [Anthropic commercial privacy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training).

## Storage and recovery

Raw audio is never written to disk by RecallFlow. With Deepgram, an in-memory queue holds at most five seconds during transcription interruptions. With Local Whisper, audio is held in memory in chunks of up to 15 seconds and a backlog of at most 90 seconds (reported as a gap if exceeded); chunks detected as silence are discarded without being transcribed, and WAV data is sent to the local server in memory. It is discarded on stop; overflow is reported as a potential transcript gap. Already transmitted speech not finalized by the provider may be lost during a disconnect. RecallFlow cannot control external provider storage or OS swap.

Transcripts, human notes, summaries, action items, participants and chat remain separate in PostgreSQL. Local mode stores them as separate fields in each meeting record. Main-process files use restrictive creation permissions and atomic replacement. Notes also have immediate renderer recovery storage; main-process notes and finalized transcript segments are journaled before database updates. No transcript or note text is intentionally written to production logs.

Local meeting files and Chromium recovery storage are **not application-encrypted**. They rely on the current OS user boundary and device security; use full-disk encryption on sensitive devices. Other software running as the same OS user may access these files. Database administrators can access server data.

API credentials entered in Settings are encrypted using Electron `safeStorage`, backed by the OS credential store. Saved keys are never returned to the renderer. The app refuses this storage path when Linux only offers the plaintext `basic_text` backend. Developer environment variables and `.env` are an alternative trusted launch configuration; `.env` is excluded from source and packages and should not be committed. The renderer only receives provider names/status, never stored keys or database URLs.

## Deletion and retention

Deleting a meeting removes the meeting, final transcript, personal notes, extraction, enhanced notes, action items, participants and chat. It also clears that meeting's application-managed recovery records and client cache. Delete all meetings removes the same entities for the local user. Database cascading relations enforce removal of associated rows.

Transcript retention can be set to 7, 30, or 90 days, or until manual deletion. It runs at startup and when changed. This removes original transcript segments and their structured citation IDs; personal notes, derived intelligence and chat remain. Use complete meeting deletion to remove those. Retention is not a secure erase guarantee: OS backups, filesystem snapshots, PostgreSQL backups, provider records and storage media recovery are beyond app control.

## Application boundary

The Electron renderers are sandboxed, with context isolation on and Node integration off. A minimal preload exposes named operations. The floating meeting window has its own, smaller preload: it can read the live meeting status and send stop, open, dismiss, quick-note and resize commands, but cannot list, read or delete meetings or change settings. Every main-process IPC handler validates the payload and checks the sender window, top frame and trusted URL. Navigation, new windows and webviews are blocked. The renderer uses a restrictive Content Security Policy, renders model output as text, and cannot execute arbitrary code, shell commands or filesystem access. Audio chunks are bounded and accepted only for the active meeting. There is no incoming network application server.

The local identity is generated once per installation. Database queries always include that user scope. Database mode is for trusted developer use: **this is not a hosted multi-tenant SaaS authorization boundary**. Before distributing a hosted service, move credentials/database access to a backend, verify authenticated sessions, enforce server-side tenancy/RLS, introduce audited access controls, rate limits, migrations, encrypted backup policies, signing/notarization and an independent security review.

Models may still make factual mistakes. Citations prove which transcript segment was referenced, not that the interpretation is correct. Unknown citations are dropped. Unsubstantiated owners/dates are cleared, notes/transcript conflicts are called out in model instructions, and users should review generated material before acting or sharing.
