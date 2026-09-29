# Learning report: compact meeting mode and local AI

This milestone added a floating meeting window, local transcription (Whisper) and local meeting intelligence (Ollama). Below, each concept is explained through the problem it solves in RecallFlow. The formal decision record is [ADR 0001](../adr/0001-compact-meeting-mode-and-local-ai.md).

## 1. Electron multi-window architecture

An Electron app has one **main process** (Node.js, full OS access) and one **renderer process** per window (Chromium, sandboxed). Windows don't share memory. They only talk to the main process.

RecallFlow now has two windows with very different jobs:

- The **main window** is the full app. Its renderer also runs the microphone capture, because `getUserMedia` and `AudioWorklet` are browser APIs that only exist in a renderer.
- The **floating window** is a 236×60 control strip. It can only display state and send commands.

The main process is the **single source of truth**. `MeetingSession` (`packages/core/session.ts`) owns the live meeting, and windows are views of it.

That is why hiding the main window, or closing the floating one, can't end a meeting: neither of them owns it. The one subtlety is that the main window's renderer holds the microphone. So during a meeting that window is hidden rather than destroyed (`mainWindowCloseAction`), and Chromium's background throttling is turned off so a hidden window keeps processing audio at full speed.

## 2. Always-on-top windows

The floating window combines several `BrowserWindow` options (`apps/desktop/electron/main.ts`, `createFloating`):

- `frame: false` and `transparent: true`, so CSS draws the rounded pill and its shadow.
- `alwaysOnTop` at the `"floating"` level, plus `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })`, so it stays visible over a full-screen Zoom call.
- `skipTaskbar`, so it adds no taskbar entry on Windows or Linux.
- `showInactive()`, so appearing doesn't steal focus from the call.
- `-webkit-app-region: drag` on the pill body makes it draggable. Buttons are marked `no-drag` so they stay clickable. On macOS, drag regions swallow mouse events, which is one reason expansion is click-based rather than hover-based.

A lesson from testing: when a frameless window changes size, the page and the OS window can briefly disagree about dimensions. The floating page therefore grows the window _before_ showing bigger content and shrinks it _after_ showing smaller content. Otherwise clicks can land on the wrong control (`show()` in `apps/desktop/src/floating.tsx`).

## 3. IPC state synchronisation

Renderers reach the main process only through the functions a **preload** script exposes with `contextBridge`. RecallFlow uses three patterns:

- **Request/response** (`ipcRenderer.invoke` / `ipcMain.handle`), for commands such as stop, open meeting or add quick note. Every handler validates its input with Zod and checks which window and page sent it.
- **Push** (`webContents.send`). When `MeetingSession` changes, the main process sends the whole `SessionState` to both windows and rebuilds the tray menu. Sending the whole state, rather than events like "mic connected", means a window that opens late only needs one `session()` call to catch up.
- **Delegation back to the capture owner.** A Stop from the floating window can't stop the microphone directly, because the mic lives in the other renderer. The main process sends `rf:capture-release` to the main window. That window saves your notes, stops the mic and calls `stop`. If it doesn't answer, a timeout stops the meeting anyway.

Each window gets only the powers it needs. The floating preload exposes seven commands and can't read meetings. Quick notes are forwarded to the main window's notes editor instead of being written by the main process, so the editor stays the only writer and autosave can't overwrite them.

## 4. Local inference

"Inference" means running a trained model on new input. Locally, that happens on your CPU/GPU instead of a provider's servers.

RecallFlow does it in two places:

- **Transcription while recording:** audio → text, continuously.
- **Intelligence after Stop:** transcript + notes → structured notes, once.

The LLM deliberately doesn't run during the meeting. Running both models at once would compete for the same memory and GPU, and summarising a half-finished meeting would be wasted work.

## 5. Whisper (via whisper.cpp)

Whisper is OpenAI's open speech-recognition model. whisper.cpp is a C/C++ port that runs it efficiently on laptops, using Metal on Apple Silicon.

- **Not a streaming model.** It transcribes finished clips, so `WhisperCppProvider` (`packages/transcription/whisper.ts`) buffers audio and cuts a chunk when there has been at least 4 s of audio and a 0.5 s pause, or 15 s at most. That is why local transcript lines appear a few seconds late.
- **Expects 16 kHz mono audio.** Microphones usually run at 44.1 or 48 kHz, so the provider resamples by averaging neighbouring samples, which also acts as a crude low-pass filter.
- **Hallucinates on silence.** Given quiet audio it produces "[BLANK_AUDIO]" or even "Thank you." RecallFlow skips silent chunks and strips bracketed non-speech markers.
- **Runs as a child process** (`whisper-server`) on a random localhost port, so the model loads once per meeting. It is isolated from the app and needs no native Node module. Verified on this machine: the tiny model transcribed 5.8 s of speech in about 0.6 s.

## 6. Ollama

Ollama downloads, stores and serves open LLMs behind a simple local HTTP API (`127.0.0.1:11434`). RecallFlow calls `/api/chat` (`packages/ai/ollama.ts`) with:

- `format`: the JSON Schema generated from RecallFlow's Zod schema. Ollama constrains generation to match it.
- `temperature: 0`, for consistent output, and `think: false`, so qwen3 answers directly.
- `num_ctx` sized to the meeting. Context size drives memory use, and Ollama's default is too small for a meeting transcript. Meetings that don't fit are refused rather than silently truncated.

Small models still make mistakes, so every response is validated with Zod. On failure the model gets one repair turn that states exactly what was wrong. If that fails too, generation fails visibly and nothing from that response is saved. This keeps RecallFlow's rule that results are never fabricated.

## 7. The provider pattern

RecallFlow codes against interfaces, not vendors:

- `TranscriptionProvider` has `connect` → `send` / `close`.
- `AIProvider` has `extract`, `present` and `answer`.

`StructuredAIProvider` holds the prompts once, so each AI backend only implements "send instruction + schema, return validated data". `createProviders(config)` (`packages/core/providers.ts`) is the one place that chooses implementations.

This is what makes local and cloud interchangeable. The meeting lifecycle, the evidence checks (`groundExtraction`) and the UI are identical whichever provider runs, so you can record the same meeting both ways and compare quality fairly.

## 8. Resource trade-offs

|                               | Disk    | RAM while running           | When it runs                       |
| ----------------------------- | ------- | --------------------------- | ---------------------------------- |
| Whisper tiny.en               | 75 MB   | ~0.3 GB                     | during the meeting                 |
| Whisper base.en (default)     | 142 MB  | ~0.4 GB                     | during the meeting                 |
| Whisper small.en              | 466 MB  | ~0.9 GB                     | during the meeting                 |
| Ollama qwen3:4b               | ~2.5 GB | ~4–6 GB (context-dependent) | after Stop, for seconds to minutes |
| Deepgram / OpenAI / Anthropic | none    | negligible                  | network calls                      |

What you get from local: privacy (meeting data stays on the device), zero cost per meeting and offline use.

What you pay:

- CPU/GPU heat, battery and memory.
- Weaker summaries than frontier models.
- No live partial words and no speaker labels.
- Installing two tools.

If transcription falls behind real time, the app reports it. The fix is a smaller Whisper model.
