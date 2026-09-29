import { mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { newMeeting, type Meeting, type Template } from "../shared";
export interface MeetingRepository {
  list(query?: string): Promise<Meeting[]>;
  get(id: string): Promise<Meeting>;
  save(meeting: Meeting): Promise<void>;
  delete(id: string): Promise<void>;
}
export async function atomicWrite(path: string, value: unknown) {
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
export class LocalRepository implements MeetingRepository {
  constructor(
    private directory: string,
    readonly userId: string,
  ) {}
  private path(id: string) {
    return join(this.directory, `${id}.json`);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async list(query = "") {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(this.directory);
    const meetings = await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(
          async (f) =>
            JSON.parse(
              await readFile(join(this.directory, f), "utf8"),
            ) as Meeting,
        ),
    );
    return meetings
      .filter(
        (m) =>
          m.userId === this.userId &&
          [
            m.title,
            m.notes,
            m.summary?.overview,
            m.summary?.detailedNotes,
            ...m.segments.map((s) => s.text),
          ]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async get(id: string) {
    const m = JSON.parse(await readFile(this.path(id), "utf8")) as Meeting;
    if (m.userId !== this.userId) throw new Error("Meeting not found");
    return m;
  }
  async save(m: Meeting) {
    if (m.userId !== this.userId) throw new Error("Meeting not found");
    await atomicWrite(this.path(m.id), m);
  }
  async delete(id: string) {
    await this.get(id);
    await rm(this.path(id), { force: true });
  }
}
export function createMeeting(
  userId: string,
  title: string,
  template: Template = "general",
) {
  return newMeeting(userId, { title, template });
}
