# ADR 0001: Compact meeting mode and fully local AI

- Status: Accepted
- Date: 2026-09-29

## Context

RecallFlow needed two things:

1. **A compact meeting mode.** During a call the full window is in the way, but recording must stay visible and controllable.
2. **A way to run with no cloud services and no per-meeting cost.** Deepgram, OpenAI and Anthropic all send meeting content to third parties and bill per use.

Two facts about the existing code shaped every decision:

- Audio is captured in the **main window's renderer**, because Chromium's `getUserMedia` and `AudioWorklet` only exist in a renderer. The renderer converts audio to PCM16 and sends 100 ms chunks over IPC.
- The **main process** already owned the transcription session, meeting lifecycle and provider keys.

## Decision 1: the floating window is separate from the recording service

A new `FloatingMeetingWindow` shows status and sends commands. It owns nothing.

All live-meeting logic moved out of `main.ts` into `MeetingSession` (`packages/core/session.ts`). It owns the transcription session, the watchdog, the power-save blocker, stop handling and post-meeting processing. It publishes a single `SessionState` object. The main window, the floating window and the tray all render that one object.

**Why:**

- **Hiding or closing a window must never end a meeting.** If the floating window held recording state, closing it would lose the meeting. Here it can only ask; the session decides.
- **Stop must happen exactly once.** A stop can come from the main window, the floating window, the tray, the no-audio watchdog or Quit. `requestStop()` is idempotent, and `stop(id)` hands every caller the same promise.
- **The microphone lives in a renderer.** A Stop from the floating window therefore asks the main window to release the mic (`rf:capture-release`), and that window then calls `stop`. If it doesn't answer within five seconds, the session stops without it.
- **The main window is hidden, never destroyed, during a meeting.** Destroying it would kill the renderer that holds the microphone. Its background throttling is switched off while recording.
- **Least privilege.** The floating window gets its own preload with seven commands. It can't list, read or delete meetings. Every IPC handler still checks the sender window, frame and URL.
- **Testability.** `MeetingSession` has no Electron imports, so the stop-exactly-once and hidden-window behaviour are unit-tested (`tests/session.test.ts`). The Electron smoke test covers the real windows.

**Alternatives considered:**

- _Capture audio in the floating window._ Rejected: the spec forbids it, and closing the floating window would kill recording.
- _Capture in a dedicated hidden window._ This would decouple capture from the main UI entirely. Deferred: it means moving the audio pipeline and notes autosave for little gain over "hide, don't close".
- _Minimize instead of hide on start._ The spec allows either. Hide was chosen because `minimize()` could not be verified in the test environment. The floating window, the tray and a Dock click all restore the main window.

## Decision 2: providers sit behind interfaces

`TranscriptionProvider` (`connect`, plus an optional `preflight`) and `AIProvider` (`extract`, `present`, `answer`) already existed.

This milestone added `StructuredAIProvider`. It holds the three prompts once, so each backend only implements "send this instruction and schema, return validated output". `createProviders(config)` is the single place that picks implementations.

**Why:**

- The meeting system (lifecycle, grounding, persistence, UI) doesn't know which model ran. Nothing model-specific leaks into it.
- Local and cloud providers can be swapped per install and compared on the same meetings, which is the stated goal.
- The same Zod schemas and the same `groundExtraction` evidence checks apply to every provider. A local model can't bypass them.

## Decision 3: Local Whisper was added

`WhisperCppProvider` runs whisper.cpp's `whisper-server` as a child process on `127.0.0.1` with a random port. It is started when a meeting starts and stopped when it ends. Audio is resampled to 16 kHz and cut into chunks at natural pauses (at least 4 s of audio plus a 0.5 s pause, at most 15 s). Only chunks containing speech are sent, as in-memory WAV.

**Why whisper.cpp through its server rather than other options:**

- **No native Node module.** A native addon would have to be rebuilt for Electron's ABI on every Electron upgrade. A separate process is also isolated: if it crashes, the app survives and reports it.
- **Model loaded once per meeting**, not per chunk. Spawning `whisper-cli` per chunk would reload the model every few seconds and pass audio through temp files.
- **Audio stays in memory.** Speech goes over loopback HTTP, never to disk.
- **Installation stays small.** The binary comes from Homebrew (`brew install whisper-cpp`) and models are downloaded separately (75–466 MB). The installer doesn't ship a model.

**Failure handling:**

- A missing model or binary is reported _before_ the meeting starts, and the meeting stays a draft so it can be retried.
- The app never falls back to a cloud provider on its own.

## Decision 4: Ollama was added

`OllamaAIProvider` calls Ollama's local `/api/chat` with the Zod schema converted to JSON Schema as `format` (constrained decoding), `temperature: 0` and `think: false`.

The output is parsed and validated with Zod. On a failure the model gets exactly one repair turn that states what was wrong. If that also fails, generation fails visibly and nothing is saved from that output. The context window (`num_ctx`) is sized per meeting, and meetings that don't fit are refused rather than silently truncated.

**Why:**

- **No per-use cost and no API key.** Ollama manages model download and quantization and serves a stable HTTP API.
- **Structured output is what RecallFlow needs.** Small local models are much less reliable than frontier models at following a schema. Constrained decoding plus validation plus one repair is the minimum that keeps "never fabricate" true.
- **Any model can be used** by name. `qwen3:4b` is the default because it is small (about 2.5 GB) and follows JSON schemas well for its size.

## Privacy and cost advantages

- With Local Whisper and Ollama on a loopback address, no meeting audio or transcript is intentionally sent off the device. The app calls this **Local Mode**. It lists anything that still transmits meeting data, such as a remote PostgreSQL database or a remote Ollama host, instead of claiming full privacy.
- **Zero marginal cost.** A long meeting costs electricity, not API fees.
- **Works offline** and isn't subject to third-party retention policies or outages.

## Drawbacks of local inference

- **Quality.** A 4B model's summaries and action items are noticeably weaker than frontier cloud models, and Whisper tiny/base make more errors than Deepgram Nova. The architecture keeps both paths so they can be compared.
- **No live partials and no speaker labels.** Whisper transcribes in 4–15 s chunks, so words appear with a delay. It doesn't diarize, so every segment is labelled "Speaker".
- **Resources.** Whisper base uses about 0.4 GB of RAM plus CPU/GPU during the meeting. qwen3:4b uses roughly 4–6 GB while generating, depending on context size, and takes seconds to minutes. On a laptop, fans spin and battery drains.
- **Setup.** Two tools and two models must be installed. The app detects them and explains what's missing, but can't install them itself.
- **Hardware variance.** Speed depends heavily on the machine. Apple Silicon with Metal is fast; older Intel machines may fall behind real time, which the app detects and reports.

## Cloud vs local trade-offs

|                            | Local (Whisper + Ollama)      | Cloud (Deepgram + OpenAI/Anthropic) |
| -------------------------- | ----------------------------- | ----------------------------------- |
| Meeting data leaves device | No (by default)               | Yes, to each provider               |
| Cost                       | Free after download           | Per minute / per token              |
| Transcript latency         | 4–15 s chunks                 | Live partial words                  |
| Speaker labels             | No                            | Yes (diarization)                   |
| Summary quality            | Good for small models, weaker | Best available                      |
| Offline                    | Yes                           | No                                  |
| Setup                      | Install tools and models      | API keys                            |
| Machine load               | High during use               | Negligible                          |

Choose local for private or personal meetings and for cost. Choose cloud when quality, live partials or speaker labels matter more than where the data goes. The provider choice is per installation, and switching doesn't change the meeting system.

## Consequences

- `main.ts` wires Electron to `MeetingSession`, and meeting logic lives in `packages/core`.
- Note generation now starts in the main process after Stop, however the meeting was stopped. The main window no longer triggers it.
- New configuration: `WHISPER_MODEL`, `WHISPER_MODEL_PATH`, `WHISPER_MODEL_DIR`, `WHISPER_SERVER_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL` and `OLLAMA_NUM_CTX`. Unset providers are auto-detected: local ones are chosen only if actually available, and otherwise the app uses mock.
