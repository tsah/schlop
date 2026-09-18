import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  AnnotationSessionSchema,
  validateSession,
  type AnnotationSession,
} from "@schlop/annotation-core";
import { AnnotationSurfaceSchema } from "@schlop/surface-protocol";

export function dataDirectory(
  env = process.env,
  platform = process.platform,
): string {
  if (env.SCHLOP_DATA_DIR) return env.SCHLOP_DATA_DIR;
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Schlop",
    );
  if (platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Schlop");
  return join(
    env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "schlop",
  );
}
export async function atomicText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}
function parseSession(raw: string): AnnotationSession {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Session contains invalid JSON");
  }
  if (
    !data ||
    typeof data !== "object" ||
    (data as { schemaVersion?: unknown }).schemaVersion !== 1
  )
    throw new Error("Unsupported session schema version");
  const shell = AnnotationSessionSchema.parse(data);
  const surface = AnnotationSurfaceSchema.parse(shell.surface);
  const session = { ...shell, surface } as AnnotationSession;
  const validation = validateSession(session);
  if (!validation.valid)
    throw new Error(`Invalid session: ${validation.errors.join("; ")}`);
  return session;
}
export class SessionStore {
  constructor(readonly root = dataDirectory()) {}
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
    return join(this.root, "sessions", `${id}.json`);
  }
  async save(session: AnnotationSession): Promise<void> {
    await atomicJson(this.path(session.id), session);
  }
  async load(id: string): Promise<AnnotationSession> {
    return parseSession(await readFile(this.path(id), "utf8"));
  }
  async list(): Promise<
    Array<
      | { session: AnnotationSession; corrupt?: false }
      | { id: string; corrupt: true; error: string }
    >
  > {
    const directory = join(this.root, "sessions");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const results = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const id = name.slice(0, -5);
          try {
            return { session: await this.load(id) } as const;
          } catch (error) {
            return {
              id,
              corrupt: true as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
    );
    const updatedAt = (item: (typeof results)[number]) =>
      item.session?.updatedAt ?? "";
    return results.sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)));
  }
  async mostRecent(): Promise<AnnotationSession | undefined> {
    const item = (await this.list()).find(
      (entry): entry is { session: AnnotationSession } => "session" in entry,
    );
    return item?.session;
  }
  async delete(id: string): Promise<void> {
    await rm(this.path(id));
  }
  async archive(id: string): Promise<void> {
    const session = await this.load(id);
    await atomicJson(join(this.root, "archive", `${id}.json`), session);
    await rm(this.path(id));
  }
}
export { atomicJson };
