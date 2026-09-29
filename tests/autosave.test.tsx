// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { useNotes, readDraft, clearAllDrafts } from "../apps/desktop/src/notes";
it("writes recovery immediately and retains it after a failed autosave", async () => {
  clearAllDrafts();
  const save = vi.fn().mockRejectedValue(new Error("offline"));
  const { result, unmount } = renderHook(() => useNotes("meeting", "", save));
  act(() => result.current.change("My important note"));
  expect(readDraft("meeting")).toBe("My important note");
  await act(async () => {
    await result.current.flush().catch(() => {});
  });
  expect(result.current.status).toBe("error");
  expect(readDraft("meeting")).toBe("My important note");
  save.mockResolvedValue(undefined);
  await act(async () => {
    await result.current.flush();
  });
  await waitFor(() => expect(result.current.status).toBe("saved"));
  expect(readDraft("meeting")).toBeNull();
  unmount();
});
it("does not claim recovery is safe when browser storage and the repository both fail", async () => {
  clearAllDrafts();
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("quota exceeded");
    });
  const save = vi.fn().mockRejectedValue(new Error("offline"));
  const { result, unmount } = renderHook(() => useNotes("quota", "", save));
  act(() => result.current.change("Copy these notes"));
  await act(async () => {
    await result.current.flush().catch(() => {});
  });
  expect(result.current.status).toBe("unsafe");
  expect(result.current.content).toBe("Copy these notes");
  unmount();
  storage.mockRestore();
});
