# RecallFlow

A private desktop meeting notebook. Press **Start Meeting**, keep talking, and RecallFlow transcribes the conversation, keeps your own notes separate, and turns both into grounded meeting notes, decisions and action items, each linked back to the transcript lines it came from.

It can run **fully on your computer**: Whisper for transcription and Ollama for the notes, so no API keys, no per-meeting cost and no meeting audio or transcript sent to cloud AI services. Or plug in Deepgram, OpenAI or Anthropic for cloud quality, and switch between the two to compare.

![Meeting notes with decisions, action items and source links](docs/screenshots/meeting-intelligence.png)

## Features

- **Live transcription:** Local Whisper (whisper.cpp) or Deepgram streaming.
- **Your notes, kept separate:** autosaved with crash recovery, and never overwritten by AI output.
- **Grounded meeting notes:** overview, decisions, action items with owners and due dates, risks and questions. Every item cites transcript segments, and unsupported owners or dates are dropped.
- **Ask this meeting:** chat with answers backed by transcript evidence.
- **Compact meeting mode:** an always-on-top floating control with the recording timer, microphone status, quick notes and Stop, plus a tray / menu-bar entry.
- **Local Mode:** transcription and intelligence both on-device, with a clear indicator and an explicit list of anything that still sends data out.
- **Privacy by design:** capture only after you press Start, raw audio never written to disk, API keys encrypted with the OS keychain, sandboxed renderers with validated IPC.
- **Templates** (General, Sales, Interview, 1:1), full-text search, transcript retention and complete deletion.

| Floating meeting control                                               | Expanded                                                             | After Stop                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| ![Collapsed floating control](docs/screenshots/floating-collapsed.png) | ![Expanded floating control](docs/screenshots/floating-expanded.png) | ![Notes ready](docs/screenshots/floating-ready.png) |

![Live meeting with notes and transcript](docs/screenshots/live-meeting.png)

## Tech stack

- **Desktop:** Electron 41 (sandboxed renderers, context isolation, OS-encrypted credential storage)
- **UI:** React 19, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, lucide-react
- **Audio:** Web Audio `AudioWorklet` → mono PCM16 over validated IPC
- **Transcription:** whisper.cpp (`whisper-server`, local) or Deepgram Nova-3 (WebSocket streaming)
- **Meeting intelligence:** Ollama (local, e.g. `qwen3:4b`), OpenAI or Anthropic, all behind one structured-output interface validated with Zod
- **Storage:** atomic local JSON store, or PostgreSQL via Prisma with full-text search
- **Testing:** Vitest and Testing Library, plus Playwright-driven Electron end-to-end tests against the dev and packaged app
- **Packaging:** electron-builder

Design decisions are recorded in [ADR 0001](docs/adr/0001-compact-meeting-mode-and-local-ai.md), and the [learning report](docs/learning/compact-mode-and-local-ai.md) explains the multi-window, IPC and local-inference concepts behind them.

## Quick start

Use Node 22 LTS or newer and npm. On macOS, microphone access must be granted to Electron in development, or RecallFlow in the packaged app.

```sh
npm install
cp .env.example .env
npm run db:generate
npm run dev
```

With no providers configured, RecallFlow auto-detects local ones: it uses Local Whisper and Ollama if they are installed and ready (see **Personal Zero-Cost Setup**), and otherwise clearly labelled mock transcription and AI. Mock transcription emits scripted sample sentences, not recognition of your voice. No paid credentials or database are needed. Local data persists in Electron's `userData` directory.

For a real meeting with cloud providers, set `TRANSCRIPTION_PROVIDER=deepgram`, `DEEPGRAM_API_KEY`, and either `AI_PROVIDER=openai` plus `OPENAI_API_KEY` or `AI_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY`. Restart the app after changing configuration. Keep `.env` private. All outbound provider calls run in Electron's main process.

For PostgreSQL, set `APP_MODE=database` and `DATABASE_URL`, then run `npm run db:migrate`. Supabase's direct or session-pooler PostgreSQL URL works; use the SSL settings appropriate to your deployment. This is a trusted single-user developer mode, not hosted authentication. Each installation has a generated local user identity and repository operations are scoped to it.

## Personal Zero-Cost Setup

Transcription and meeting intelligence both run on your computer. No API keys, no per-meeting cost, and no meeting audio or transcript sent to cloud AI services. These steps are for macOS with Homebrew; whisper.cpp and Ollama also run on Windows and Linux (point `WHISPER_SERVER_PATH` at your `whisper-server` build).

### 1. Local Whisper (transcription)

```sh
brew install whisper-cpp
mkdir -p ~/.recallflow/models
curl -L -o ~/.recallflow/models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

| Model            | Download | RAM while recording | Notes                                                        |
| ---------------- | -------- | ------------------- | ------------------------------------------------------------ |
| `tiny`           | 75 MB    | ~0.3 GB             | Fastest; more mistakes. Good for older machines.             |
| `base` (default) | 142 MB   | ~0.4 GB             | Best starting point on a laptop.                             |
| `small`          | 466 MB   | ~0.9 GB             | Noticeably more accurate; needs a recent CPU/GPU to keep up. |

To use another model, download its file (`ggml-tiny.en.bin` or `ggml-small.en.bin`, same URL pattern) into `~/.recallflow/models` and choose it in Settings. Use `WHISPER_MODEL_DIR` or `WHISPER_MODEL_PATH` for a different location, and `WHISPER_SERVER_PATH` if `whisper-server` isn't in `/opt/homebrew/bin`, `/usr/local/bin` or your `PATH`. Models are downloaded separately so the installer stays small.

### 2. Ollama with qwen3:4b (meeting intelligence)

```sh
brew install ollama      # or install the app from https://ollama.com
ollama serve             # or open the Ollama app; leave it running
ollama pull qwen3:4b     # about 2.5 GB
```

Any Ollama model name works, for example `qwen3:8b` (better, about 5 GB and more RAM), `gemma3:4b` or `llama3.2:3b`. Pull it first, then enter its name in Settings.

### 3. Select them

Either leave `TRANSCRIPTION_PROVIDER` and `AI_PROVIDER` unset (both are then auto-detected at launch), or open **Settings → AI configuration → Use fully local**, or set them in `.env`:

```sh
TRANSCRIPTION_PROVIDER=whisper
AI_PROVIDER=ollama
```

Settings should show **Local Whisper: Ready** and **Ollama: Connected — qwen3:4b**. Use each **Test** button to load the model once. The top bar then shows **Local Mode**. If a model is missing, starting a meeting shows the exact problem. RecallFlow never falls back to a paid or cloud provider on its own.

### What to expect

- **CPU, GPU and RAM:** Whisper runs during the meeting (about 0.4 GB RAM for base). Ollama runs only after you press Stop and uses roughly 4–6 GB RAM with qwen3:4b for anywhere from a few seconds to a few minutes; fans may spin up. Close other heavy apps on 8 GB machines. If transcription falls behind, the app warns you; switch to a smaller Whisper model.
- **Differences from cloud:** transcript lines appear in 4–15 second chunks rather than word by word, there are no speaker labels, and a 4B model's notes are simpler than those from frontier cloud models.
- **Comparing quality:** both paths stay available. Switch providers in Settings to compare local and cloud on your own meetings.

Why it's built this way: [ADR 0001](docs/adr/0001-compact-meeting-mode-and-local-ai.md). How it works: [learning report](docs/learning/compact-mode-and-local-ai.md).

## Compact meeting mode

When recording starts (and the microphone is confirmed), the full window hides and a small always-on-top control shows the recording dot, elapsed time, microphone state and Stop. Click the chevron for transcription, microphone and system-audio status, a **Quick note** box (added to My Notes) and **Open meeting**. Stop takes two clicks so a stray click can't end a meeting. After Stop the control shows _Processing notes…_ then _Notes ready_.

The tray / menu-bar icon offers Open RecallFlow, the meeting status, Stop meeting and Quit. Closing or hiding either window never stops a meeting. Quitting during a meeting asks for confirmation. Turn the automatic hiding off in **Settings → Meetings → Compact meeting window**.

## Commands

```sh
npm run check        # TypeScript, ESLint, Vitest
npm run build        # renderer and Electron bundles
npm run package      # unpacked desktop application
npm run dist         # platform installer (signing requires your certificates)
npm run db:generate  # Prisma client
npm run db:migrate   # PostgreSQL migrations
npm run db:seed      # explicitly labelled sample meeting
```

`npm run dev:web` serves renderer assets only. The actual application requires the Electron preload bridge and is started with `npm run dev`.

## Audio support

Microphone capture uses Chromium media permissions and an AudioWorklet producing mono PCM16. The actual AudioContext sample rate is sent to Deepgram. System audio is opt-in. Windows uses Electron's supported loopback API; macOS 15+ uses the experimental native system picker. If the OS supplies no audio track, the app reports system audio unavailable and continues with the microphone. Linux and older macOS use microphone capture. No kernel extensions, virtual drivers, hidden capture, or meeting bots are installed. Headphones reduce echo and duplicated speech when mixing sources. Speaker labels are diarization labels, not verified participant identities.

See [Electron display-media documentation](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts) and [Deepgram streaming reference](https://developers.deepgram.com/reference/speech-to-text/listen-streaming).

## Tomorrow's meeting test

Use real provider configuration for this checklist; a mock test does not validate speech recognition.

- [ ] Launch the desktop app and check Settings → audio permission diagnostics.
- [ ] Confirm Deepgram and your AI provider are selected.
- [ ] Create **Test Meeting** and review the transcription consent reminder.
- [ ] Press **Start Meeting**, grant microphone permission, and confirm the visible red recording state.
- [ ] Speak for 30 seconds, including an explicit decision and an action with an owner.
- [ ] Confirm live transcript and audio level appear. Check system audio separately if enabled.
- [ ] Type several notes, including a highlighted note with Cmd/Ctrl+Enter.
- [ ] Press **Stop Meeting**; confirm capture indicator and OS microphone access stop.
- [ ] Confirm structured notes, decisions and action items generate; inspect their source links.
- [ ] Ask a question in **Ask this meeting** and inspect its evidence.
- [ ] Quit and reopen; confirm the meeting and personal notes remain.
- [ ] Delete the meeting and confirm it disappears from search and the dashboard.
- [ ] Repeat with a temporary network interruption; notes must remain editable and recoverable.

## Troubleshooting

- **Microphone denied:** enable the app in OS privacy settings and restart. A permission failure is displayed; notes remain available.
- **No live speech recognition:** mock mode uses sample text. Select Deepgram, add a valid key, restart, and check connection status.
- **Connection interrupted:** reconnect is bounded. The UI reports gaps; audio is never written to disk. Speech already sent but not finalized may be lost.
- **AI generation failed:** check credentials/network, then select Retry intelligence. It reuses saved transcript and notes.
- **Notes not saved to database:** local recovery remains available; retry when the database is reachable. Do not clear application data before recovering notes.
- **Database unavailable at startup:** correct `DATABASE_URL`/migrations; local mode can run independently. It does not silently migrate or combine stores.
- **npm cache permission error:** use `npm install --cache /tmp/recallflow-npm-cache` if your global cache points to an unavailable volume.
- **Unsigned macOS build:** local packaging is unsigned. Public distribution needs Developer ID signing and notarization.

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [PRIVACY.md](PRIVACY.md) before deploying to other users.

## Secure provider configuration in the desktop app

Open **Settings → Intelligence & transcription**. Choose Deepgram and an AI provider, enter your keys, and select **Save providers securely**. Keys are encrypted with the OS credential store and providers update immediately; saved keys are not displayed again. Explicit environment variables override saved configuration on the next launch. Mock mode is the safe default for a fresh installation.

## Local PostgreSQL integration testing

```sh
docker compose up -d
DATABASE_URL='postgresql://recallflow:local_development_only@127.0.0.1:54329/recallflow' npm run db:migrate
TEST_DATABASE_URL='postgresql://recallflow:local_development_only@127.0.0.1:54329/recallflow' npm test
```

The PostgreSQL integration test creates isolated UUID users and removes only their data. Without `TEST_DATABASE_URL`, it is explicitly skipped. The local repository, recovery, providers, extraction, lifecycle and React autosave tests still run.

`npm run test:desktop` builds the app and runs the Electron workflow with synthetic microphone input and mock providers, in an isolated temporary profile. It checks the floating controls (hidden main window keeps recording, quick note, Stop from the floating window), sources, chat, restart persistence and deletion, and writes screenshots into `artifacts/`. It does not validate physical audio or paid API credentials. After `npm run package`, `npm run test:packaged` runs the same workflow against the packaged macOS app; prefix it with `APP_MODE=database DATABASE_URL=...` to exercise PostgreSQL from the package.

The Prisma client is generated into `packages/database/generated` (git-ignored) and shipped beside the bundles, because its native query engine is located relative to the client. Run `npm run db:generate` after install and before building. All other code is bundled, so runtime libraries live in `devDependencies` and the app archive stays small.

AI requests currently cap serialized context at 220,000 characters and output at 8,000 tokens. Oversized meetings fail visibly with saved transcript/notes intact rather than silently dropping content. Chunked long-meeting synthesis and semantic retrieval are future work. Live language defaults to English.

## License

[MIT](LICENSE) © Aryan Yadav
