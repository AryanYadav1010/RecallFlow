import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  systemPreferences,
  desktopCapturer,
  powerSaveBlocker,
  safeStorage,
  screen,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import pino from "pino";
import { IntelligenceService } from "../../../packages/core/intelligence";
import {
  EnvSchema,
  resolveConfig,
  whisperModelPath,
  type Config,
} from "./config";
import {
  createProviders,
  detectLocalProviders,
  findWhisperServer,
  localMode,
  providerStatuses,
  testProvider,
} from "../../../packages/core/providers";
import {
  MeetingSession,
  mainWindowCloseAction,
} from "../../../packages/core/session";
import {
  LocalRepository,
  atomicWrite,
  type MeetingRepository,
} from "../../../packages/database";
import { PostgresRepository } from "../../../packages/database/postgres";
import { MeetingService } from "../../../packages/core/service";
import {
  CreateSchema,
  IdSchema,
  NoteSchema,
  SettingsSchema,
  ProviderConfigSchema,
  ProviderIdSchema,
  FloatingSizeSchema,
  FLOATING_SIZES,
  UserFacingError,
  sessionLabel,
  type Settings,
  type AppInfo,
  type SessionState,
} from "../../../packages/shared";
if (process.env.RECALLFLOW_DATA_DIR)
  app.setPath("userData", process.env.RECALLFLOW_DATA_DIR);
const logger = pino({ level: "info", base: undefined });
let mainWindow: BrowserWindow;
let floating: BrowserWindow | null = null;
let floatingHiddenByUser = false;
let tray: Tray | null = null;
let quitting = false;
let session: MeetingSession;
let settings: Settings = {
  defaultTemplate: "general",
  transcriptRetentionDays: null,
  compactOnStart: true,
};
const devURL = !app.isPackaged ? "http://127.0.0.1:5173" : undefined;
const useDev = !!process.env.VITE_DEV_SERVER_URL && !!devURL;
const pageURL = (page: string) =>
  useDev
    ? `${devURL}/${page === "index.html" ? "" : page}`
    : pathToFileURL(join(__dirname, "../dist", page)).href;
type IpcEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainEvent;
const fromFrame = (
  window: BrowserWindow | null,
  page: string,
  event: IpcEvent,
) =>
  !!window &&
  !window.isDestroyed() &&
  event.sender === window.webContents &&
  event.senderFrame === window.webContents.mainFrame &&
  event.senderFrame?.url === pageURL(page);
const fromMain = (event: IpcEvent) =>
  fromFrame(mainWindow, "index.html", event);
const fromFloating = (event: IpcEvent) =>
  fromFrame(floating, "floating.html", event);
function lockDown(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
}
function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}
function createFloating() {
  const area = screen.getPrimaryDisplay().workArea;
  const size = FLOATING_SIZES.collapsed;
  const window = new BrowserWindow({
    ...size,
    x: area.x + area.width - size.width - 16,
    y: area.y + 16,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: "RecallFlow meeting controls",
    webPreferences: {
      preload: join(__dirname, "preload-floating.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  lockDown(window);
  // Closing the controls only hides them; it never touches the recording.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
    floatingHiddenByUser = true;
    updateTray(session.state);
  });
  if (useDev) void window.loadURL(pageURL("floating.html"));
  else void window.loadFile(join(__dirname, "../dist/floating.html"));
  window.once("ready-to-show", () => syncFloating(session.state));
  return window;
}
function syncFloating(state: SessionState) {
  if (state.phase === "idle") {
    floating?.hide();
    return;
  }
  floating ??= createFloating();
  if (!floatingHiddenByUser && !floating.isVisible()) floating.showInactive();
}
function resizeFloating(size: keyof typeof FLOATING_SIZES) {
  if (!floating) return;
  const bounds = floating.getBounds();
  const next = FLOATING_SIZES[size];
  const area = screen.getDisplayMatching(bounds).workArea;
  const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(v, min), max);
  // Keep the right edge anchored: the default position is the top-right corner.
  floating.setBounds({
    ...next,
    x: clamp(
      bounds.x + bounds.width - next.width,
      area.x,
      area.x + area.width - next.width,
    ),
    y: clamp(bounds.y, area.y, area.y + area.height - next.height),
  });
}
/** A drawn ring (filled while recording), so no image asset is needed. */
function trayImage(recording: boolean) {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const template = process.platform === "darwin";
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if (!((d >= 9 && d <= 12.5) || (recording && d <= 5.5))) continue;
      const i = (y * size + x) * 4; // BGRA
      pixels[i] = template ? 0 : 0x47;
      pixels[i + 1] = template ? 0 : 0x5c;
      pixels[i + 2] = template ? 0 : 0x31;
      pixels[i + 3] = 255;
    }
  const image = nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 2,
  });
  image.setTemplateImage(template);
  return image;
}
function updateTray(state: SessionState) {
  try {
    tray ??= new Tray(trayImage(false));
  } catch {
    return; // Some Linux desktops have no tray.
  }
  tray.setImage(trayImage(state.phase === "recording"));
  tray.setToolTip(`RecallFlow — ${sessionLabel(state)}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open RecallFlow", click: showMain },
      { type: "separator" },
      { label: sessionLabel(state), enabled: false },
      ...(state.phase !== "idle" && floatingHiddenByUser
        ? [
            {
              label: "Show meeting controls",
              click: () => {
                floatingHiddenByUser = false;
                syncFloating(session.state);
                updateTray(session.state);
              },
            },
          ]
        : []),
      {
        label: "Stop meeting",
        enabled: state.phase === "recording",
        click: () => session.requestStop(),
      },
      { type: "separator" },
      { label: "Quit RecallFlow", click: () => app.quit() },
    ]),
  );
}
async function boot() {
  const root = app.getPath("userData");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const secureStorage =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text");
  let stored: Record<string, string> = {};
  try {
    const encrypted = JSON.parse(
      await readFile(join(root, "providers.json"), "utf8"),
    ) as { encrypted: string };
    if (!secureStorage) throw new Error("Secure storage unavailable");
    stored = z
      .record(z.string())
      .parse(
        JSON.parse(
          safeStorage.decryptString(Buffer.from(encrypted.encrypted, "base64")),
        ),
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const raw = EnvSchema.parse({ ...stored, ...process.env });
  let config: Config = resolveConfig(raw, await detectLocalProviders(raw));
  let whisperServer = await findWhisperServer(config);
  let identity: string;
  try {
    identity = IdSchema.parse(
      JSON.parse(await readFile(join(root, "identity.json"), "utf8")).id,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    identity = crypto.randomUUID();
    await atomicWrite(join(root, "identity.json"), { id: identity });
  }
  try {
    settings = SettingsSchema.parse(
      JSON.parse(await readFile(join(root, "settings.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let repo: MeetingRepository;
  if (config.APP_MODE === "database") {
    const { PrismaClient } =
      await import("../../../packages/database/generated");
    const pg = new PostgresRepository(new PrismaClient(), identity);
    await pg.init();
    repo = pg;
  } else {
    const local = new LocalRepository(join(root, "meetings"), identity);
    await local.init();
    repo = local;
  }
  const service = new MeetingService(repo, identity, join(root, "recovery"));
  await service.init();
  await service.retain(settings);
  let providers = createProviders(config, whisperServer);
  let intelligence = new IntelligenceService(service, providers.ai);
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#f8f9f6",
    title: "RecallFlow",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  lockDown(mainWindow);
  const send = (channel: string, value: unknown) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
  };
  session = new MeetingSession({
    service,
    transcription: () => providers.transcription,
    intelligence: () => intelligence,
    onTranscript: (event) => send("rf:transcript", event),
    onState: (state) => {
      send("rf:session", state);
      if (floating && !floating.isDestroyed())
        floating.webContents.send("rf:session", state);
      if (state.phase === "recording" && !floating?.isVisible()) {
        floatingHiddenByUser = false;
        resizeFloating("collapsed");
      }
      // Capture runs in the main renderer, so it keeps full speed when hidden.
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.setBackgroundThrottling(
          state.phase !== "recording" && state.phase !== "stopping",
        );
      syncFloating(state);
      updateTray(state);
    },
    releaseCapture: (id) => send("rf:capture-release", id),
    keepAwake: {
      start: () => powerSaveBlocker.start("prevent-app-suspension"),
      stop: (id) => powerSaveBlocker.stop(id),
    },
  });
  const recording = () => session.state.phase === "recording";
  mainWindow.webContents.session.setPermissionRequestHandler(
    (wc, permission, callback, details) =>
      callback(
        wc === mainWindow.webContents &&
          recording() &&
          ((permission === "media" &&
            !(
              "mediaTypes" in details && details.mediaTypes?.includes("video")
            )) ||
            (permission === "display-capture" &&
              session.state.systemAudio !== "off")),
      ),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (wc, permission) =>
      wc === mainWindow.webContents && recording() && permission === "media",
  );
  mainWindow.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        !recording() ||
        session.state.systemAudio === "off" ||
        request.frame !== mainWindow.webContents.mainFrame ||
        process.platform !== "win32"
      ) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        callback({ video: sources[0], audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: process.platform === "darwin" },
  );
  mainWindow.webContents.on("render-process-gone", () => {
    const id = session.recordingId;
    if (id)
      void session
        .stop(
          id,
          "The app renderer stopped. Saved notes and transcript can be recovered.",
        )
        .catch(() => logger.warn({ code: "capture_cleanup_failed" }));
  });
  mainWindow.on("close", (event) => {
    if (mainWindowCloseAction(session.state, quitting) === "hide") {
      event.preventDefault();
      mainWindow.hide();
      floatingHiddenByUser = false;
      syncFloating(session.state);
    }
  });
  mainWindow.on("closed", () => app.quit());
  const busy = async () =>
    session.busy || (await repo.list()).some((m) => intelligence.isBusy(m.id));
  const handle = <T>(
    channel: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    fn: (input: T) => Promise<unknown> | unknown,
    trusted = fromMain,
  ) =>
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      try {
        return await fn(schema.parse(input));
      } catch (error) {
        logger.warn(
          {
            channel,
            code:
              error instanceof z.ZodError ? "validation" : "operation_failed",
          },
          "Request failed",
        );
        throw new Error(
          error instanceof z.ZodError
            ? "Invalid request."
            : error instanceof UserFacingError ||
                (error instanceof Error &&
                  error.message.startsWith("Cannot change"))
              ? error.message
              : "This operation could not be completed. Your locally recovered notes are preserved. Check configuration and try again.",
        );
      }
    });
  handle("rf:info", z.undefined(), (): AppInfo => ({
    mode: config.APP_MODE,
    ai: config.AI_PROVIDER,
    transcription: config.TRANSCRIPTION_PROVIDER,
    platform: process.platform,
    microphonePermission:
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "requested on Start",
    systemAudioSupported:
      process.platform === "win32" ||
      (process.platform === "darwin" &&
        Number(process.getSystemVersion().split(".")[0]) >= 15),
    settings,
    development: !app.isPackaged,
    secureStorage,
    whisper: {
      model: config.WHISPER_MODEL,
      modelPath: whisperModelPath(config),
      serverPath: whisperServer,
    },
    ollama: { model: config.OLLAMA_MODEL, host: config.OLLAMA_HOST },
    localMode: localMode(config),
  }));
  handle("rf:configure", ProviderConfigSchema, async (input) => {
    if (!secureStorage)
      throw new UserFacingError("Secure credential storage is unavailable.");
    if (await busy())
      throw new UserFacingError("Wait for active operations to finish.");
    const next = resolveConfig(
      EnvSchema.parse({
        ...config,
        AI_PROVIDER: input.aiProvider,
        TRANSCRIPTION_PROVIDER: input.transcriptionProvider,
        DEEPGRAM_API_KEY: input.deepgramKey?.trim() || config.DEEPGRAM_API_KEY,
        OPENAI_API_KEY: input.openaiKey?.trim() || config.OPENAI_API_KEY,
        ANTHROPIC_API_KEY:
          input.anthropicKey?.trim() || config.ANTHROPIC_API_KEY,
        WHISPER_MODEL: input.whisperModel ?? config.WHISPER_MODEL,
        OLLAMA_MODEL: input.ollamaModel || config.OLLAMA_MODEL,
      }),
      { whisperReady: false, ollamaReachable: false },
    );
    const values = Object.fromEntries(
      (
        [
          "AI_PROVIDER",
          "TRANSCRIPTION_PROVIDER",
          "WHISPER_MODEL",
          "OLLAMA_MODEL",
          "DEEPGRAM_API_KEY",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
        ] as const
      )
        .filter((key) => next[key])
        .map((key) => [key, next[key]]),
    );
    await atomicWrite(join(root, "providers.json"), {
      encrypted: safeStorage
        .encryptString(JSON.stringify(values))
        .toString("base64"),
    });
    config = next;
    whisperServer = await findWhisperServer(config);
    providers = createProviders(config, whisperServer);
    intelligence = new IntelligenceService(service, providers.ai);
  });
  handle("rf:providers", z.undefined(), () =>
    providerStatuses(config, whisperServer),
  );
  handle("rf:test-provider", ProviderIdSchema, (id) => {
    if (session.busy)
      throw new UserFacingError("Stop the meeting before testing providers.");
    return testProvider(id, config, whisperServer);
  });
  handle("rf:session", z.undefined(), () => session.state);
  handle("rf:list", z.string().max(500).optional(), (q) => repo.list(q));
  handle("rf:get", IdSchema, (id) => repo.get(id));
  handle("rf:create", CreateSchema, (input) =>
    service.create(input.title, input.template),
  );
  handle("rf:notes", NoteSchema, (input) =>
    service.saveNotes(input.id, input.content),
  );
  handle(
    "rf:start",
    z.object({
      id: IdSchema,
      sampleRate: z.number().int().min(8000).max(192000),
      systemAudio: z.boolean(),
    }),
    (input) => session.start(input),
  );
  ipcMain.on("rf:audio", (event, input: unknown) => {
    if (!fromMain(event)) return;
    const parsed = z
      .object({
        id: IdSchema,
        data: z
          .instanceof(ArrayBuffer)
          .refine((b) => b.byteLength > 0 && b.byteLength <= 192000),
      })
      .safeParse(input);
    if (parsed.success)
      session.audio(parsed.data.id, Buffer.from(parsed.data.data));
  });
  ipcMain.on("rf:capture-source", (event, input: unknown) => {
    if (!fromMain(event)) return;
    const parsed = z
      .object({
        id: IdSchema,
        source: z.enum(["microphone", "system"]),
        connected: z.boolean(),
      })
      .safeParse(input);
    if (!parsed.success) return;
    const { id, source, connected } = parsed.data;
    const firstConnection =
      source === "microphone" &&
      connected &&
      session.state.microphone === "waiting";
    session.source(id, source, connected);
    // Capture is confirmed working, so the full window steps aside. It is
    // hidden, not closed: its renderer owns the microphone. The floating
    // window, tray and Dock icon all bring it back.
    if (firstConnection && settings.compactOnStart) mainWindow.hide();
  });
  handle("rf:stop", IdSchema, (id) => session.stop(id));
  handle("rf:generate", IdSchema, (id) => session.generate(id));
  handle(
    "rf:action",
    z.object({ id: IdSchema, actionId: IdSchema, done: z.boolean() }),
    (input) =>
      service.update(input.id, (m) => {
        const a = m.actions.find((a) => a.id === input.actionId);
        if (!a) throw new Error("Action not found");
        a.status = input.done ? "done" : "open";
      }),
  );
  handle(
    "rf:chat",
    z.object({ id: IdSchema, question: z.string().trim().min(1).max(4000) }),
    (input) => intelligence.chat(input.id, input.question),
  );
  handle("rf:delete", IdSchema, (id) => {
    if (intelligence.isBusy(id))
      throw new UserFacingError("Wait for intelligence to finish.");
    if (session.recordingId === id)
      throw new UserFacingError("Stop recording before deleting.");
    return service.delete(id);
  });
  handle("rf:delete-all", z.undefined(), async () => {
    if (await busy())
      throw new UserFacingError("Stop recording and wait for AI to finish.");
    return service.deleteAll();
  });
  handle("rf:settings", SettingsSchema, async (input) => {
    if (await busy())
      throw new UserFacingError("Wait for active operations to finish.");
    await atomicWrite(join(root, "settings.json"), input);
    settings = input;
    await service.retain(settings);
  });
  // The floating window gets its own, much smaller set of commands.
  const floatingHandle = <T>(
    channel: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    fn: (input: T) => Promise<unknown> | unknown,
  ) => handle(channel, schema, fn, fromFloating);
  floatingHandle("rf:floating:session", z.undefined(), () => session.state);
  floatingHandle("rf:floating:stop", z.undefined(), () => {
    session.requestStop();
  });
  floatingHandle("rf:floating:dismiss", z.undefined(), () => session.dismiss());
  floatingHandle("rf:floating:open", z.undefined(), () => {
    showMain();
    if (session.state.meetingId)
      send("rf:open-meeting", session.state.meetingId);
  });
  floatingHandle(
    "rf:floating:note",
    z.string().trim().min(1).max(2000),
    (text) => {
      const id = session.recordingId;
      if (!id || !recording())
        throw new UserFacingError("Quick notes are available while recording.");
      // The notes editor stays the only writer, so autosave cannot clobber this.
      send("rf:quick-note", { meetingId: id, text });
    },
  );
  floatingHandle("rf:floating:resize", FloatingSizeSchema, (size) =>
    resizeFloating(size),
  );
  updateTray(session.state);
  if (useDev) await mainWindow.loadURL(devURL!);
  else await mainWindow.loadFile(join(__dirname, "../dist/index.html"));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showMain);
  app.on("activate", showMain);
  app.on("before-quit", (event) => {
    if (quitting || !session?.busy) {
      quitting = true;
      return;
    }
    event.preventDefault();
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      message: "A meeting is still recording. Stop it and quit RecallFlow?",
      detail:
        "Recording stops and the transcript so far is saved. Notes are not generated until you reopen RecallFlow and select Retry intelligence.",
      buttons: ["Keep recording", "Stop and quit"],
      defaultId: 0,
      cancelId: 0,
    });
    if (choice !== 1) return;
    const reason =
      "Recording stopped because RecallFlow quit. Your transcript and notes are saved; select Retry intelligence.";
    const id = session.recordingId;
    session.requestStop({ failWith: reason });
    void (id ? session.stop(id, reason) : Promise.resolve())
      .catch(() => {})
      .finally(() => {
        quitting = true;
        app.quit();
      });
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      logger.error({ code: "startup_failed" }, "Startup failed");
      dialog.showErrorBox(
        "RecallFlow could not start",
        error instanceof z.ZodError
          ? "Invalid configuration"
          : error instanceof UserFacingError
            ? error.message
            : "Check your database connection, migrations, disk space, and .env configuration. Existing meeting files have been preserved.",
      );
      quitting = true;
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
