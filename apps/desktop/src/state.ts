import { create } from "zustand";
import { idleSession, type SessionState } from "../../../packages/shared";
export const useNavigation = create<{
  page: string;
  meetingId: string | null;
  captureActive: boolean;
  setCapture: (active: boolean) => void;
  setPage: (page: string) => void;
  open: (id: string | null) => void;
}>((set) => ({
  page: "Meetings",
  meetingId: null,
  captureActive: false,
  setCapture: (captureActive) => set({ captureActive }),
  setPage: (page) => set({ page, meetingId: null }),
  open: (meetingId) => set({ meetingId }),
}));
/** Mirror of the main process's live meeting state. */
export const useSession = create<SessionState>(() => idleSession);
