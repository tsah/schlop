// Host-independent logic for the Pi extension. Runs under Pi's Node runtime, so
// it uses only node: modules and no Schlop workspace packages.
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

type SessionEntryLike = {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
};

// "Last" means the active conversation branch, newest entry first.
export function lastAssistantText(branch: readonly unknown[]): string | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as SessionEntryLike | undefined;
    const message = entry?.type === "message" ? entry.message : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content))
      continue;
    const text = message.content
      .filter(
        (block): block is { type: "text"; text: string } =>
          block?.type === "text" && typeof block.text === "string",
      )
      .map((block) => block.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return null;
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

export async function prepareRequest(
  content: string,
  title: string,
): Promise<PreparedRequest> {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-"));
  const contentPath = join(directory, "message.md");
  const requestPath = join(directory, "request.json");
  const resultPath = join(directory, "result.json");
  const requestId = `pi-${randomUUID()}`;
  const request = {
    schemaVersion: 1,
    requestId,
    surface: {
      kind: "markdown",
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
