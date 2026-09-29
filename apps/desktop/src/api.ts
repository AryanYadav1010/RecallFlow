import type { DesktopAPI } from "../../../packages/shared";
declare global {
  interface Window {
    recallflow?: DesktopAPI;
  }
}
export const api = window.recallflow!;
/** Strips Electron's "Error invoking remote method" wrapper from IPC errors. */
export const errorMessage = (error: unknown) =>
  String(error).replace(
    /^Error: Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
