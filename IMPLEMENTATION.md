# Implementation checklist

- [x] Phase 1: Electron shell, shared schemas, database adapters, dashboard
- [x] Phase 2: lifecycle, notes autosave and local recovery
- [x] Phase 3: PCM microphone pipeline, Deepgram, reconnect and mock
- [x] Phase 4: extraction, presentation, source links and retry
- [x] Phase 5: meeting chat, PostgreSQL search, templates, settings
- [x] Phase 6: security review, failure tests, documentation and packaged build
- [x] Compact meeting mode: floating window, tray, quit confirmation, shared session state
- [x] Fully local mode: Local Whisper (whisper.cpp) and Ollama providers, AI configuration settings, Local Mode indicator
- [ ] Real microphone, Deepgram and AI provider validation (README "Tomorrow's meeting test")
- [ ] Real Ollama validation (provider tested against a fake server only; Ollama is not installed on the build machine)
- [ ] Developer ID signing and notarization for public distribution

Each phase ends with TypeScript, ESLint and relevant tests. Real microphone/API validation requires OS permission and user-provided credentials; mock output is always labelled.

The packaged app has been verified end to end with mock providers in both local and PostgreSQL modes (`npm run test:packaged`, optionally with `APP_MODE=database DATABASE_URL=...`).
