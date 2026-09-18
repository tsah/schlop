#!/usr/bin/env bun
import { Effect } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSession, type AnnotationSession } from "@schlop/annotation-core";
import {
  COMPLETION_EXIT_CODES,
  createResult,
  exportJson,
  exportMarkdown,
  type AnnotationResult,
} from "@schlop/annotation-export";
import {
  createRequestSurface,
  loadRequest,
  validateResult,
} from "@schlop/annotation-protocol";
import { atomicText, SessionStore } from "@schlop/annotation-storage";
import { fileProvider, isFileSurfaceStale } from "@schlop/provider-file";
import { gitProvider, isGitSurfaceStale } from "@schlop/provider-git";
import { stdinProvider, type StdinType } from "@schlop/provider-stdin";
import { validateGuidedDiffOverlay } from "@schlop/overlay-protocol";
import type { AnnotationSurface } from "@schlop/surface-protocol";
import { runTui } from "../../tui/src/app";
import { runController } from "./controller";
import {
  discoverRuntime,
  doctorReport,
  launchNvim,
  nvimDiagnostic,
  resolveNvim,
} from "./nvim";

export const EXIT = COMPLETION_EXIT_CODES;
const usage = `Schlop — Check the schlop before you ship.

Usage:
  schlop [--ui tui|nvim] [--nvim PATH] diff [git-diff arguments]
  schlop [--ui tui|nvim] file <path> [--type text|markdown]
  schlop [--ui tui|nvim] annotate --stdin [--type text|markdown|diff]
  schlop --request <request.json>
  schlop resume [session-id]
  schlop sessions [--delete ID | --archive ID]
  schlop export [session-id] --format markdown|json [--output FILE]
  schlop doctor [--nvim PATH]

The existing OpenTUI frontend remains the default. Set --ui nvim or SCHLOP_UI=nvim
for standalone Neovim. Completion exit codes: submitted/approved 0, error 1,
cancelled 20.`;
function option(args: string[], name: string): string | undefined {
  const boundary = args.indexOf("--");
  const limit = boundary >= 0 ? boundary : args.length;
  for (let index = 0; index < limit; index++) {
    const value = args[index]!;
    if (value === name) {
      const selected = args[index + 1];
      if (!selected || index + 1 >= limit || selected.startsWith("--"))
        throw new Error(`${name} requires a value`);
      return selected;
    }
    if (value.startsWith(`${name}=`)) {
      const selected = value.slice(name.length + 1);
      if (!selected) throw new Error(`${name} requires a value`);
      return selected;
    }
  }
  return undefined;
}
function withoutOption(args: string[], name: string): string[] {
  const output: string[] = [];
  const boundary = args.indexOf("--");
  const limit = boundary >= 0 ? boundary : args.length;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (index < limit && value === name) {
      index++;
      continue;
    }
    if (index < limit && value.startsWith(`${name}=`)) continue;
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
async function annotateTui(
  session: AnnotationSession,
  store: SessionStore,
  resultFile?: string,
) {
  await store.save(session);
  const result = await runTui(session, (next) => store.save(next), {
    stale: await stale(session),
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
async function annotateNvim(
  session: AnnotationSession,
  store: SessionStore,
  options: {
    nvim?: string;
    resultFile?: string;
    requestId?: string;
    keepTemporary?: boolean;
  } = {},
) {
  const nvim = await resolveNvim(options.nvim);
  if (nvim.error || !nvim.path) throw new Error(nvimDiagnostic(nvim));
  const runtime = await discoverRuntime();
  if (!runtime)
    throw new Error(
      "Schlop's packaged Lua runtime is missing. Reinstall Schlop or set SCHLOP_RUNTIME.",
    );
  await store.save(session);
  const temporary = options.resultFile
    ? undefined
    : await mkdtemp(join(tmpdir(), "schlop-result-"));
  const resultPath = resolve(
    options.resultFile ?? join(temporary!, "result.json"),
  );
  try {
    await rm(resultPath, { force: true });
    const childCode = await launchNvim({
      nvim: nvim.path,
      runtime,
      session,
      resultPath,
      requestId: options.requestId,
      keepTemporary: options.keepTemporary,
    });
    if (childCode === 130) return 130;
    if (childCode !== 0)
      throw new Error(`Neovim exited with status ${childCode}`);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(resultPath, "utf8"));
    } catch {
      throw new Error("Neovim exited without a complete Schlop result");
    }
    const result = validateResult(value, {
      requestId: options.requestId,
      session,
    });
    if (!options.resultFile && result.outcome !== "cancelled")
      process.stdout.write(result.formattedFeedback ?? "");
    return EXIT[result.outcome];
  } finally {
    if (temporary && !options.keepTemporary)
      await rm(temporary, { recursive: true, force: true });
  }
}
async function execute(rawArgs: string[]): Promise<number> {
  if (rawArgs[0] === "__controller") {
    if (!rawArgs[1]) throw new Error("Controller launch path is required");
    await runController(rawArgs[1]);
    return 0;
  }
  const explicitNvim = option(rawArgs, "--nvim");
  const ui = option(rawArgs, "--ui") ?? process.env.SCHLOP_UI ?? "tui";
  if (ui !== "tui" && ui !== "nvim")
    throw new Error("--ui must be tui or nvim");
  const args = withoutOption(withoutOption(rawArgs, "--nvim"), "--ui");
  const command = args[0];
  const store = new SessionStore();
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(usage);
    return 0;
  }
  if (command === "doctor") {
    const report = await doctorReport(explicitNvim);
    process.stdout.write(report.text);
    return report.okay ? 0 : 1;
  }
  if (command === "--request") {
    if (!args[1]) throw new Error("--request requires a JSON file path");
    const loaded = await loadRequest(args[1]);
    const { request } = loaded;
    const surface = createRequestSurface(loaded);
    return annotateNvim(createSession(surface), store, {
      nvim: explicitNvim,
      resultFile: request.resultPath,
      requestId: request.requestId,
      keepTemporary: args.includes("--keep-temporary"),
    });
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
    return ui === "nvim"
      ? annotateNvim(session, store, {
          nvim: explicitNvim,
          resultFile: option(args, "--result-file"),
        })
      : annotateTui(session, store, option(args, "--result-file"));
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
    await store.save({
      ...session,
      overlays: [...session.overlays, overlay],
      updatedAt: new Date().toISOString(),
    });
    return 0;
  }
  let surface: AnnotationSurface;
  if (!command || command === "diff")
    surface = await gitProvider.createSurface({
      args: command
        ? withoutOption(args.slice(1), "--result-file").filter(
            (argument) => argument !== "--keep-temporary",
          )
        : [],
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
  const session = createSession(surface);
  return ui === "nvim"
    ? annotateNvim(session, store, {
        nvim: explicitNvim,
        resultFile: option(args, "--result-file"),
        keepTemporary: args.includes("--keep-temporary"),
      })
    : annotateTui(session, store, option(args, "--result-file"));
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
process.exit(await Effect.runPromise(program));
