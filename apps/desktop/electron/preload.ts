import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../../../packages/shared";
const subscribe =
  <T>(channel: string) =>
  (callback: (value: T) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: T) =>
      callback(value);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
const api: DesktopAPI = {
  configure: (input) => ipcRenderer.invoke("rf:configure", input),
  info: () => ipcRenderer.invoke("rf:info"),
  list: (q) => ipcRenderer.invoke("rf:list", q),
  get: (id) => ipcRenderer.invoke("rf:get", id),
  create: (input) => ipcRenderer.invoke("rf:create", input),
  saveNotes: (input) => ipcRenderer.invoke("rf:notes", input),
  start: (input) => ipcRenderer.invoke("rf:start", input),
  audio: (input) => ipcRenderer.send("rf:audio", input),
  stop: (id) => ipcRenderer.invoke("rf:stop", id),
  generate: (id) => ipcRenderer.invoke("rf:generate", id),
  action: (input) => ipcRenderer.invoke("rf:action", input),
  chat: (input) => ipcRenderer.invoke("rf:chat", input),
  delete: (id) => ipcRenderer.invoke("rf:delete", id),
  deleteAll: () => ipcRenderer.invoke("rf:delete-all"),
  settings: (input) => ipcRenderer.invoke("rf:settings", input),
  providers: () => ipcRenderer.invoke("rf:providers"),
  testProvider: (id) => ipcRenderer.invoke("rf:test-provider", id),
  session: () => ipcRenderer.invoke("rf:session"),
  captureSource: (input) => ipcRenderer.send("rf:capture-source", input),
  onTranscript: subscribe("rf:transcript"),
  onSession: subscribe("rf:session"),
  onCaptureRelease: subscribe("rf:capture-release"),
  onQuickNote: subscribe("rf:quick-note"),
  onOpenMeeting: subscribe("rf:open-meeting"),
};
contextBridge.exposeInMainWorld("recallflow", api);
