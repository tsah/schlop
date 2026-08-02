#!/usr/bin/env bun
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createSession, type AnnotationSession } from "@schlop/annotation-core";
import {
  COMPLETION_EXIT_CODES,
  createResult,
  exportJson,
  exportMarkdown,
  type AnnotationResult,
} from "@schlop/annotation-export";
import { atomicText, SessionStore } from "@schlop/annotation-storage";
import { fileProvider, isFileSurfaceStale } from "@schlop/provider-file";
import { gitProvider, isGitSurfaceStale } from "@schlop/provider-git";
import { stdinProvider, type StdinType } from "@schlop/provider-stdin";
import { validateGuidedDiffOverlay } from "@schlop/overlay-protocol";
import { runTui } from "../../tui/src/app";

export const EXIT = COMPLETION_EXIT_CODES;
const usage = `Schlop — Check the schlop before you ship.

Usage:
  schlop                              Annotate current Git changes
  schlop diff [git-diff arguments]    Annotate a Git diff
  schlop file <path> [--type text|markdown]
  schlop annotate --stdin [--type text|markdown|diff] [--title TITLE]
  schlop resume [session-id]
  schlop sessions [--delete ID | --archive ID]
  schlop export [session-id] --format markdown|json [--output FILE]
  schlop overlay add <guide.json> [--session ID]

Completion exit codes: submitted 0, cancelled 20, error 1.`;
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0
    ? args[index + 1]
    : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}
function withoutOption(args: string[], name: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === name) {
      index++;
      continue;
    }
    if (value.startsWith(`${name}=`)) continue;
    output.push(value);
  }
  return output;
}
async function stale(session: AnnotationSession): Promise<boolean> {
  if (session.surface.metadata.provider === "file")
    return isFileSurfaceStale(session.surface);
  if (
    session.surface.kind === "diff" &&
    session.surface.metadata.provider === "git"
  )
    return isGitSurfaceStale(session.surface);
  return false;
}
async function annotate(
  session: AnnotationSession,
  store: SessionStore,
  resultFile?: string,
): Promise<number> {
  await store.save(session);
  const sourceIsStale = await stale(session);
  const result = await runTui(session, (next) => store.save(next), {
    stale: sourceIsStale,
  });
  const completion = createResult(result.session, result.outcome);
  if (resultFile)
    await atomicText(
      resolve(resultFile),
      `${JSON.stringify(completion, null, 2)}\n`,
    );
  else if (result.outcome !== "cancelled")
    process.stdout.write(completion.formattedFeedback ?? "");
  return EXIT[result.outcome];
}
async function execute(args: string[]): Promise<number> {
  const store = new SessionStore();
  const command = args[0];
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    return 0;
  }
  if (command === "sessions") {
    const deleteId = option(args, "--delete");
    const archiveId = option(args, "--archive");
    if (deleteId) {
      await store.delete(deleteId);
      return 0;
    }
    if (archiveId) {
      await store.archive(archiveId);
      return 0;
    }
    for (const item of await store.list())
      console.log(
        "session" in item
          ? `${item.session.id}\t${item.session.updatedAt}\t${item.session.surface.kind}\t${item.session.surface.title}`
          : `${item.id}\tCORRUPT\t${item.error}`,
      );
    return 0;
  }
  if (command === "export") {
    const positional =
      args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    const session = positional
      ? await store.load(positional)
      : await store.mostRecent();
    if (!session) throw new Error("No session found");
    const format = option(args, "--format") ?? "markdown";
    if (format !== "markdown" && format !== "json")
      throw new Error(`Unsupported export format: ${format}`);
    const output =
      format === "json" ? exportJson(session) : exportMarkdown(session);
    const path = option(args, "--output");
    if (path) await atomicText(resolve(path), output);
    else process.stdout.write(output);
    return 0;
  }
  if (command === "resume") {
    const id = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
    const session = id ? await store.load(id) : await store.mostRecent();
    if (!session) throw new Error("No compatible session found");
    return annotate(session, store, option(args, "--result-file"));
  }
  if (command === "overlay") {
    if (args[1] !== "add" || !args[2])
      throw new Error("Usage: schlop overlay add <guide.json> [--session ID]");
    const id = option(args, "--session");
    const session = id ? await store.load(id) : await store.mostRecent();
    if (!session) throw new Error("No session found");
    const overlay = validateGuidedDiffOverlay(
      JSON.parse(await readFile(resolve(args[2]), "utf8")),
      session.surface,
    );
    const now = new Date().toISOString();
    await store.save({
      ...session,
      overlays: [...session.overlays, overlay],
      updatedAt: now,
    });
    return 0;
  }
  let surface;
  if (!command || command === "diff")
    surface = await gitProvider.createSurface({
      args: command ? withoutOption(args.slice(1), "--result-file") : [],
    });
  else if (command === "file") {
    if (!args[1]) throw new Error("schlop file requires a path");
    const type = option(args, "--type");
    if (type && type !== "text" && type !== "markdown")
      throw new Error("File type must be text or markdown");
    surface = await fileProvider.createSurface({
      path: args[1],
      ...(type ? { type: type as "text" | "markdown" } : {}),
    });
  } else if (command === "annotate") {
    if (!args.includes("--stdin"))
      throw new Error("Only --stdin input is supported by annotate");
    const type = (option(args, "--type") ?? "text") as StdinType;
    if (!["text", "markdown", "diff"].includes(type))
      throw new Error("Stdin type must be text, markdown, or diff");
    surface = await stdinProvider.createSurface({
      type,
      title: option(args, "--title"),
      sourceLabel: option(args, "--source-label"),
    });
  } else throw new Error(`Unknown command: ${command}\n\n${usage}`);
  return annotate(createSession(surface), store, option(args, "--result-file"));
}

const args = process.argv.slice(2);
const resultFile = option(args, "--result-file");
const program = Effect.tryPromise({
  try: () => execute(args),
  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
}).pipe(
  Effect.catchAll((error) =>
    Effect.tryPromise({
      try: async () => {
        const result: AnnotationResult = {
          schemaVersion: 1,
          outcome: "error",
          error: { code: "SCHLOP_ERROR", message: error.message },
        };
        if (resultFile)
          await atomicText(
            resolve(resultFile),
            `${JSON.stringify(result, null, 2)}\n`,
          );
        process.stderr.write(`schlop: ${error.message}\n`);
        return EXIT.error;
      },
      catch: () => error,
    }),
  ),
);
const exitCode = await Effect.runPromise(program);
process.exit(exitCode);
