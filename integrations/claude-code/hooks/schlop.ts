// Claude Code UserPromptSubmit hook behind /schlop-file, /schlop-last, and
// /schlop-message, and their shorthands /slf, /sll, and /slm.
//
// Claude Code cannot hand its terminal to a child process, and a command's
// `!` shell step is cut off after two minutes, so the interactive part runs
// here: the hook opens Schlop's Neovim frontend in a tmux popup or a zoomed
// herdr pane, waits for it, then either blocks the prompt (nothing reaches the
// model) or attaches the formatted feedback as context for the command's turn.
//
// Runs under plain Node (type stripping), so it uses only node: modules and is
// self-contained: an installed plugin is copied away from this checkout.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
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

type HookInput = {
  prompt?: unknown;
  cwd?: unknown;
  transcript_path?: unknown;
};

export type SchlopCommand =
  | { name: "file"; argument: string }
  | { name: "last" }
  | { name: "message"; argument: string };

// Short names, installed as user commands because Claude Code namespaces
// every plugin command.
const shorthands: Record<string, string> = {
  slf: "file",
  sll: "last",
  slm: "message",
};

// Claude Code reports plugin commands with their namespace
// ("/schlop:schlop-file"), whether or not the user typed it; user commands
// such as the shorthands arrive bare ("/slf").
export function parseCommand(prompt: string): SchlopCommand | null {
  const match =
    /^\/(?:schlop:)?(schlop-file|schlop-last|schlop-message|slf|sll|slm)(?:\s+([\s\S]*))?$/.exec(
      prompt.trim(),
    );
  if (!match) return null;
  const argument = match[2]?.trim() ?? "";
  const name = shorthands[match[1]!] ?? match[1]!.slice("schlop-".length);
  return name === "last"
    ? { name: "last" }
    : { name: name as "file" | "message", argument };
}

type TranscriptEntry = {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  logicalParentUuid?: unknown;
  isSidechain?: unknown;
  isApiErrorMessage?: unknown;
  message?: { id?: unknown; content?: unknown };
};

function textOf(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

// The assistant messages with text on the active branch (the parentUuid chain
// from the newest entry), oldest first. Claude Code stores one entry per
// content block, so the entries sharing a message id are joined. A compaction
// starts a new chain whose boundary entry points back only through
// logicalParentUuid; following it keeps the compacted messages annotatable.
export function assistantMessages(transcript: string): string[] {
  const entries: TranscriptEntry[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially written final line is not part of the conversation yet.
    }
  }
  const byUuid = new Map<string, TranscriptEntry>();
  for (const entry of entries)
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
  let entry = [...entries]
    .reverse()
    .find((item) => typeof item.uuid === "string" && item.isSidechain !== true);
  const messages: string[] = [];
  let messageId: unknown;
  let parts: string[] = [];
  const flush = () => {
    if (parts.length) messages.unshift(parts.join("\n"));
    parts = [];
    messageId = undefined;
  };
  const seen = new Set<unknown>();
  while (entry && !seen.has(entry.uuid)) {
    seen.add(entry.uuid);
    if (entry.type === "assistant" && entry.isApiErrorMessage !== true) {
      const id = entry.message?.id ?? entry.uuid;
      if (id !== messageId) flush();
      messageId = id;
      const text = textOf(entry);
      if (text.trim()) parts.unshift(text);
    } else flush();
    const parent =
      typeof entry.parentUuid === "string"
        ? entry.parentUuid
        : entry.logicalParentUuid;
    entry = typeof parent === "string" ? byUuid.get(parent) : undefined;
  }
  flush();
  return messages;
}

export function lastAssistantText(transcript: string): string | null {
  return assistantMessages(transcript).at(-1) ?? null;
}

// One picker row per message: its first non-empty line, flattened.
export function pickerLabel(text: string): string {
  const line =
    text
      .split("\n")
      .map((item) => item.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? "";
  return line.replaceAll("\t", " ").slice(0, 200);
}

export type SurfaceKind = "text" | "markdown";
export type AnnotatableFile =
  { kind: SurfaceKind; title: string; content: string } | { error: string };

// Mirrors Schlop's own content limit so problems surface before any pane opens.
const maxFileBytes = 10 * 1024 * 1024;

// Accepts Claude Code's @-mention completion ("@src/a.ts") as well as quotes.
export async function readAnnotatableFile(
  argument: string,
  cwd: string,
): Promise<AnnotatableFile> {
  const typed = argument
    .trim()
    .replace(/^@/, "")
    .replace(/^(["'])(.*)\1$/, "$2");
  if (!typed) return { error: "Usage: /schlop-file <path>" };
  const path =
    typed === "~" || typed.startsWith("~/")
      ? join(homedir(), typed.slice(1))
      : resolve(cwd, typed);
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

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// SCHLOP_BIN, then PATH, then the build output of the checkout this plugin
// lives in (true for --plugin-dir, not for a copied marketplace install).
export function resolveSchlop(
  env: Record<string, string | undefined>,
  pluginRoot: string,
): string | null {
  if (env.SCHLOP_BIN) return executable(env.SCHLOP_BIN) ? env.SCHLOP_BIN : null;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory && executable(join(directory, "schlop")))
      return join(directory, "schlop");
  }
  const local = resolve(pluginRoot, "../../dist/schlop");
  return executable(local) ? local : null;
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
    // Interrupted (130), cancelled (20), or a closed pane (null) may leave no
    // result.
    return exitStatus === 130 || exitStatus === 20 || exitStatus === null
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

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((done) => setTimeout(done, milliseconds));
}

function herdr(args: string[], env: Record<string, string | undefined>): any {
  const child = spawnSync("herdr", args, { encoding: "utf8", env });
  if (child.status !== 0)
    throw new Error(
      `herdr ${args[0]} ${args[1]} failed: ${(child.stderr || child.error?.message || "").trim()}`,
    );
  return child.stdout.trim() ? JSON.parse(child.stdout).result : null;
}

// Runs `script` where the user can see it and waits for it to exit. Returns
// the exit status the script recorded, or null when it never finished (for
// example, the pane was closed by hand).
async function runVisible(
  script: string,
  statusPath: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<number | null> {
  if (env.TMUX) {
    // A full-size popup over Claude Code's pane; blocks until Schlop exits.
    const child = spawnSync(
      "tmux",
      [
        "display-popup",
        ...(env.TMUX_PANE ? ["-t", env.TMUX_PANE] : []),
        "-E",
        "-w",
        "100%",
        "-h",
        "100%",
        "-d",
        cwd,
        script,
      ],
      { encoding: "utf8", env },
    );
    if (!existsSync(statusPath) && (child.error || child.status !== 0))
      throw new Error(
        `tmux display-popup failed: ${(child.stderr || child.error?.message || `status ${child.status}`).trim()}`,
      );
  } else if (env.HERDR_PANE_ID) {
    // A zoomed split of Claude Code's pane. It closes itself when the script
    // exits, and herdr returns focus to Claude Code.
    const pane = herdr(
      [
        "pane",
        "split",
        env.HERDR_PANE_ID,
        "--direction",
        "right",
        "--cwd",
        cwd,
        "--no-focus",
      ],
      env,
    ).pane.pane_id as string;
    herdr(["pane", "zoom", pane, "--on"], env);
    herdr(["pane", "run", pane, `exec ${quote(script)}`], env);
    for (let tick = 0; !existsSync(statusPath); tick++) {
      await sleep(200);
      if (
        tick % 10 === 9 &&
        spawnSync("herdr", ["pane", "get", pane], { stdio: "ignore", env })
          .status !== 0
      )
        break;
    }
  } else {
    throw new Error(
      "Schlop opens Neovim in a tmux popup or a herdr pane; run Claude Code inside tmux or herdr.",
    );
  }
  try {
    return Number.parseInt(await readFile(statusPath, "utf8"), 10);
  } catch {
    return null;
  }
}

type Document = { content: string; title: string; kind: SurfaceKind };

// Opens Schlop on one document. Given several, an fzf picker (newest first)
// runs in the same popup or pane before Schlop; escaping it cancels.
async function annotate(
  documents: Document[],
  cwd: string,
  env: Record<string, string | undefined>,
  pluginRoot: string,
): Promise<Outcome> {
  const schlop = resolveSchlop(env, pluginRoot);
  if (!schlop)
    return {
      kind: "error",
      message:
        "Schlop executable not found. Put schlop on PATH or set SCHLOP_BIN.",
    };
  const directory = await mkdtemp(join(tmpdir(), "schlop-claude-"));
  try {
    const resultPath = join(directory, "result.json");
    const statusPath = join(directory, "status");
    const script = join(directory, "run.sh");
    const requestId = `claude-code-${randomUUID()}`;
    // Only one request ever runs, so they share the id and result path.
    for (const [index, document] of documents.entries()) {
      const folder = join(directory, String(index + 1));
      await mkdir(folder, { mode: 0o700 });
      const contentPath = join(
        folder,
        `content.${document.kind === "markdown" ? "md" : "txt"}`,
      );
      const request = {
        schemaVersion: 1,
        requestId,
        surface: {
          kind: document.kind,
          title: document.title,
          contentPath,
          snapshotId: `sha256:${createHash("sha256").update(document.content, "utf8").digest("hex")}`,
        },
        source: { label: "claude-code" },
        resultPath,
        options: { readOnly: true },
      };
      await writeFile(contentPath, document.content, {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeFile(
        join(folder, "request.json"),
        `${JSON.stringify(request, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    // The status file is written last, after the result is in place.
    const finish = `echo $? > ${quote(`${statusPath}.tmp`)} && mv ${quote(`${statusPath}.tmp`)} ${quote(statusPath)}`;
    let body = `${quote(schlop)} --request ${quote(join(directory, "1", "request.json"))}\n${finish}\n`;
    if (documents.length > 1) {
      const list = join(directory, "messages.tsv");
      await writeFile(
        list,
        documents
          .map(
            (document, index) =>
              `${index + 1}\t${pickerLabel(document.content)}\n`,
          )
          .join(""),
        { encoding: "utf8", mode: 0o600 },
      );
      const fzf = [
        "fzf",
        "--delimiter='\t'",
        "--with-nth=2..",
        "--no-sort",
        "--cycle",
        `--header=${quote("Pick a message to annotate in Schlop · Enter opens · Esc cancels")}`,
        `--preview=${quote(`cat ${quote(directory)}/{1}/content.md`)}`,
        "--preview-window=right,60%,wrap",
      ].join(" ");
      body = `choice=$(SHELL=/bin/sh ${fzf} < ${quote(list)}) || { ${finish}; exit; }\n${quote(schlop)} --request ${quote(directory)}/"\${choice%%\t*}"/request.json\n${finish}\n`;
    }
    await writeFile(script, `#!/bin/sh\n${body}`, { mode: 0o700 });
    const status = await runVisible(script, statusPath, cwd, env);
    return await readOutcome(resultPath, requestId, status);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function onPath(name: string, env: Record<string, string | undefined>) {
  return (env.PATH ?? "")
    .split(delimiter)
    .some((directory) => directory && executable(join(directory, name)));
}

// Returns the hook's stdout JSON, or null to let an unrelated prompt through.
export async function handle(
  input: HookInput,
  env: Record<string, string | undefined>,
  pluginRoot: string,
): Promise<object | null> {
  const command =
    typeof input.prompt === "string" ? parseCommand(input.prompt) : null;
  if (!command) return null;
  const block = (reason: string) => ({ decision: "block", reason });
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  let outcome: Outcome;
  try {
    if (command.name === "file") {
      const file = await readAnnotatableFile(command.argument, cwd);
      if ("error" in file) return block(file.error);
      outcome = await annotate([file], cwd, env, pluginRoot);
    } else {
      const transcript =
        typeof input.transcript_path === "string"
          ? await readFile(input.transcript_path, "utf8").catch(() => "")
          : "";
      const messages = assistantMessages(transcript).reverse();
      if (!messages.length) return block("No assistant message to annotate.");
      let picked = messages;
      let title = "Assistant message";
      if (command.name === "last") {
        picked = messages.slice(0, 1);
        title = "Last assistant message";
      } else if (command.argument) {
        // "/schlop-message 2" skips the picker: 1 is the last message.
        const index = Number(command.argument);
        if (!Number.isInteger(index) || index < 1 || index > messages.length)
          return block(
            `Usage: /schlop-message [n], where n is 1 (last) to ${messages.length}`,
          );
        picked = [messages[index - 1]!];
      } else if (messages.length > 1 && !onPath("fzf", env))
        return block(
          "Picking a message needs fzf on PATH. Install it, or pass a number: /schlop-message 2 (1 is the last message).",
        );
      outcome = await annotate(
        picked.map((content) => ({ content, title, kind: "markdown" })),
        cwd,
        env,
        pluginRoot,
      );
    }
  } catch (error: any) {
    return block(`Schlop failed: ${error?.message ?? error}`);
  }
  if (outcome.kind === "error")
    return block(`Schlop failed: ${outcome.message}`);
  if (outcome.kind === "cancelled")
    return block("Schlop cancelled; nothing sent.");
  if (!outcome.annotationCount) return block("No annotations; nothing sent.");
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: outcome.feedback,
    },
  };
}

if (import.meta.main) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let input: HookInput = {};
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Not a hook payload we understand; let the prompt through untouched.
  }
  const output = await handle(
    input,
    process.env,
    process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dirname, ".."),
  );
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}
