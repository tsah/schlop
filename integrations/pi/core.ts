// Host-independent logic for the Pi extension. Runs under Pi's Node runtime, so
// it uses only node: modules and no Schlop workspace packages.
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

type SessionEntryLike = {
  id?: unknown;
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
};

// The text of an assistant message entry, or null for anything else
// (user messages, tool-only turns, compactions, labels, ...).
export function assistantText(entry: unknown): string | null {
  const candidate = entry as SessionEntryLike | undefined;
  const message = candidate?.type === "message" ? candidate.message : undefined;
  if (message?.role !== "assistant" || !Array.isArray(message.content))
    return null;
  const text = message.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
  return text.trim() ? text : null;
}

// "Last" means the active conversation branch, newest entry first.
export function lastAssistantEntry(
  branch: readonly unknown[],
): { id: string | undefined; text: string } | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const text = assistantText(branch[index]);
    if (text === null) continue;
    const id = (branch[index] as SessionEntryLike).id;
    return { id: typeof id === "string" ? id : undefined, text };
  }
  return null;
}

export function lastAssistantText(branch: readonly unknown[]): string | null {
  return lastAssistantEntry(branch)?.text ?? null;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// SCHLOP_BIN, then PATH, then the build output of the checkout this extension
// lives in, so a local package install works without a system-wide Schlop.
export function resolveSchlop(
  env: Record<string, string | undefined>,
  extensionDirectory: string,
): string | null {
  if (env.SCHLOP_BIN) return executable(env.SCHLOP_BIN) ? env.SCHLOP_BIN : null;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory && executable(join(directory, "schlop")))
      return join(directory, "schlop");
  }
  const local = resolve(extensionDirectory, "../../dist/schlop");
  return executable(local) ? local : null;
}

export type PreparedRequest = {
  directory: string;
  requestPath: string;
  resultPath: string;
  requestId: string;
  cleanup: () => Promise<void>;
};

export type SurfaceKind = "text" | "markdown";

export async function prepareRequest(
  content: string,
  title: string,
  kind: SurfaceKind = "markdown",
): Promise<PreparedRequest> {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-"));
  const contentPath = join(
    directory,
    kind === "markdown" ? "content.md" : "content.txt",
  );
  const requestPath = join(directory, "request.json");
  const resultPath = join(directory, "result.json");
  const requestId = `pi-${randomUUID()}`;
  const request = {
    schemaVersion: 1,
    requestId,
    surface: {
      kind,
      title,
      contentPath,
      snapshotId: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    },
    source: { label: "pi" },
    resultPath,
    options: { readOnly: true },
  };
  await writeFile(contentPath, content, { encoding: "utf8", mode: 0o600 });
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    directory,
    requestPath,
    resultPath,
    requestId,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export type Outcome =
  | { kind: "submitted"; annotationCount: number; feedback: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export async function readOutcome(
  resultPath: string,
  requestId: string,
  exitStatus: number | null,
): Promise<Outcome> {
  let value: any;
  try {
    value = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      return { kind: "error", message: "Schlop wrote an unreadable result" };
    // Interrupted (130) and cancelled (20) sessions may leave no result.
    return exitStatus === 130 || exitStatus === 20
      ? { kind: "cancelled" }
      : {
          kind: "error",
          message: `Schlop exited with status ${exitStatus} and no result`,
        };
  }
  if (value?.schemaVersion !== 1 || value.requestId !== requestId)
    return { kind: "error", message: "Schlop result does not match request" };
  if (value.outcome === "cancelled") return { kind: "cancelled" };
  if (
    value.outcome === "submitted" &&
    Array.isArray(value.annotations) &&
    typeof value.formattedFeedback === "string"
  )
    return {
      kind: "submitted",
      annotationCount: value.annotations.length,
      feedback: value.formattedFeedback,
    };
  return {
    kind: "error",
    message: String(value.error?.message ?? "Schlop reported an error"),
  };
}

// Mirrors Schlop's own content limit so problems surface before Pi's TUI is
// suspended rather than as a launch error afterwards.
const maxFileBytes = 10 * 1024 * 1024;

function expandPath(argument: string, cwd: string): string {
  const path = argument
    .trim()
    .replace(/^@/, "")
    .replace(/^(["'])(.*)\1$/, "$2");
  if (path === "~" || path.startsWith("~/"))
    return join(homedir(), path.slice(1));
  return resolve(cwd, path);
}

export type AnnotatableFile =
  { kind: SurfaceKind; title: string; content: string } | { error: string };

// The file is frozen at read time; the title is the cwd-relative path when the
// file lives under cwd, so every feedback heading names the file.
export async function readAnnotatableFile(
  argument: string,
  cwd: string,
): Promise<AnnotatableFile> {
  if (!argument.trim()) return { error: "Usage: /schlop-file <path>" };
  const path = expandPath(argument, cwd);
  const shown = relative(cwd, path);
  const title =
    shown && !shown.startsWith("..") && !isAbsolute(shown) ? shown : path;
  let bytes: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { error: `Not a regular file: ${title}` };
    if (info.size > maxFileBytes)
      return { error: `File is larger than 10 MiB: ${title}` };
    bytes = await readFile(path);
  } catch (error: any) {
    return {
      error:
        error?.code === "ENOENT"
          ? `File not found: ${title}`
          : `Cannot read ${title}: ${error?.message ?? error}`,
    };
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { error: `Not a UTF-8 text file: ${title}` };
  }
  if (content.includes("\0")) return { error: `Not a text file: ${title}` };
  const markdown = [".md", ".markdown", ".mdx"].includes(
    extname(path).toLowerCase(),
  );
  return { kind: markdown ? "markdown" : "text", title, content };
}

// Directory-listing completion for the path argument, relative to cwd.
export async function pathCompletions(
  prefix: string,
  cwd: string,
): Promise<{ value: string; label: string }[] | null> {
  const typed = prefix.replace(/^@/, "");
  const slash = typed.lastIndexOf("/");
  const base = typed.slice(0, slash + 1);
  const partial = typed.slice(slash + 1);
  const directory = base ? expandPath(base, cwd) : cwd;
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const items = entries
      .filter(
        (entry) =>
          entry.name.startsWith(partial) &&
          (partial.startsWith(".") || !entry.name.startsWith(".")),
      )
      .map((entry) => {
        const name = entry.isDirectory() ? `${entry.name}/` : entry.name;
        return { value: `${base}${name}`, label: name };
      })
      .sort(
        (a, b) =>
          Number(b.label.endsWith("/")) - Number(a.label.endsWith("/")) ||
          a.label.localeCompare(b.label),
      )
      .slice(0, 50);
    return items.length ? items : null;
  } catch {
    return null;
  }
}
