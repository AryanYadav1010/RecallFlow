import { contextBridge, ipcRenderer } from "electron";
import type { FloatingAPI, SessionState } from "../../../packages/shared";
// Only meeting controls: no meeting list, transcript, settings or deletion.
const api: FloatingAPI = {
  session: () => ipcRenderer.invoke("rf:floating:session"),
  onSession: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SessionState) =>
      callback(state);
    ipcRenderer.on("rf:session", listener);
    return () => {
      ipcRenderer.removeListener("rf:session", listener);
    };
  },
  stop: () => ipcRenderer.invoke("rf:floating:stop"),
  openMeeting: () => ipcRenderer.invoke("rf:floating:open"),
  dismiss: () => ipcRenderer.invoke("rf:floating:dismiss"),
  note: (text) => ipcRenderer.invoke("rf:floating:note", text),
  resize: (size) => ipcRenderer.invoke("rf:floating:resize", size),
};
contextBridge.exposeInMainWorld("floating", api);
