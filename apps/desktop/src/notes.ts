import { useEffect, useRef, useState } from "react";
const key = (id: string) => `recallflow:notes:${id}`;
export function readDraft(id: string): string | null {
  try {
    const raw = window.localStorage.getItem(key(id));
    return raw === null
      ? null
      : (JSON.parse(raw) as { content: string }).content;
  } catch {
    return null;
  }
}
export function writeDraft(id: string, content: string) {
  window.localStorage.setItem(
    key(id),
    JSON.stringify({ content, savedAt: new Date().toISOString() }),
  );
}
export function clearDraft(id: string) {
  window.localStorage.removeItem(key(id));
}
export function clearAllDrafts() {
  Object.keys(window.localStorage)
    .filter((k) => k.startsWith("recallflow:notes:"))
    .forEach((k) => window.localStorage.removeItem(k));
}
export function useNotes(
  id: string,
  initial: string,
  save: (id: string, content: string) => Promise<void>,
) {
  const [content, setContent] = useState(() => readDraft(id) ?? initial);
  const [status, setStatus] = useState<
    "saved" | "saving" | "recovered" | "error" | "unsafe"
  >(() => (readDraft(id) !== null ? "recovered" : "saved"));
  const latest = useRef(content);
  const hasRecovery = useRef(readDraft(id) !== null);
  const version = useRef(0);
  const savedVersion = useRef(readDraft(id) !== null ? -1 : 0);
  const queue = useRef(Promise.resolve());
  const alive = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;
  const persist = () => {
    if (savedVersion.current === version.current) return queue.current;
    const value = latest.current;
    const currentVersion = version.current;
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          await saveRef.current(id, value);
          if (currentVersion === version.current) {
            clearDraft(id);
            savedVersion.current = currentVersion;
            if (alive.current) setStatus("saved");
          }
        } catch (error) {
          if (alive.current)
            setStatus(hasRecovery.current ? "error" : "unsafe");
          throw error;
        }
      });
    return queue.current;
  };
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(() => {
    alive.current = true;
    const timer = setInterval(() => {
      void persistRef.current().catch(() => {});
    }, 700);
    return () => {
      alive.current = false;
      clearInterval(timer);
      void persistRef.current().catch(() => {});
    };
  }, [id]);
  function change(value: string) {
    latest.current = value;
    version.current++;
    setContent(value);
    try {
      writeDraft(id, value);
      hasRecovery.current = true;
      setStatus("saving");
    } catch {
      hasRecovery.current = false;
      setStatus("unsafe");
      void persist().catch(() => {});
    }
  }
  /** Adds a line at the end, e.g. a quick note from the floating window. */
  function append(line: string) {
    const current = latest.current;
    change(current + (current && !current.endsWith("\n") ? "\n" : "") + line);
  }
  return { content, change, append, status, flush: persist };
}
