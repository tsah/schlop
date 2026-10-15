// Pi extension: /schlop-last (/sll), /schlop-message (/slm), and /schlop-file
// (/slf) open the last assistant message, one picked in the session tree, or a
// file in Schlop's Neovim frontend and send the submitted annotations back as
// a user message.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistantText,
  lastAssistantEntry,
  lastAssistantText,
  pathCompletions,
  prepareRequest,
  readAnnotatableFile,
  readOutcome,
  resolveSchlop,
  type SurfaceKind,
} from "./core";

// Structural subset of Pi's ExtensionAPI, so this package needs no Pi
// dependency to typecheck inside the Schlop workspace.
type Tui = {
  terminal: { rows: number };
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
};
type CommandContext = {
  mode?: string;
  hasUI?: boolean;
  cwd?: string;
  isIdle(): boolean;
  sessionManager: {
    getBranch(): unknown[];
    getTree(): unknown[];
    getLeafId(): string | null;
    getEntry(id: string): unknown;
  };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    custom<T>(
      factory: (
        tui: Tui,
        theme: unknown,
        keybindings: unknown,
        done: (value: T) => void,
      ) => { render(width: number): string[]; invalidate(): void },
    ): Promise<T>;
  };
};
type ExtensionAPI = {
  registerCommand(
    name: string,
    command: {
      description: string;
      getArgumentCompletions?: (
        prefix: string,
      ) => Promise<{ value: string; label: string }[] | null>;
      handler(args: string, ctx: CommandContext): Promise<void>;
    },
  ): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
};

const extensionDirectory = dirname(fileURLToPath(import.meta.url));

function requireTui(command: string, ctx: CommandContext): boolean {
  if (ctx.mode !== undefined ? ctx.mode === "tui" : ctx.hasUI) return true;
  ctx.ui.notify(`/${command} requires Pi's interactive TUI.`, "error");
  return false;
}

async function annotate(
  pi: ExtensionAPI,
  ctx: CommandContext,
  content: string,
  title: string,
  kind: SurfaceKind,
): Promise<void> {
  const executable = resolveSchlop(process.env, extensionDirectory);
  if (!executable) {
    ctx.ui.notify(
      "Schlop executable not found. Put schlop on PATH or set SCHLOP_BIN.",
      "error",
    );
    return;
  }
  const request = await prepareRequest(content, title, kind);
  try {
    // Schlop's Neovim needs the terminal to itself: suspend Pi's renderer,
    // run to completion, then restore and redraw.
    const launch = await ctx.ui.custom<{
      status: number | null;
      error?: string;
    }>((tui, _theme, _keybindings, done) => {
      tui.stop();
      process.stdout.write("\x1b[2J\x1b[H");
      const child = spawnSync(executable, ["--request", request.requestPath], {
        stdio: "inherit",
        env: process.env,
      });
      tui.start();
      tui.requestRender(true);
      done({ status: child.status, error: child.error?.message });
      return { render: () => [], invalidate: () => {} };
    });
    if (launch.error) {
      ctx.ui.notify(`Failed to launch Schlop: ${launch.error}`, "error");
      return;
    }
    const outcome = await readOutcome(
      request.resultPath,
      request.requestId,
      launch.status,
    );
    if (outcome.kind === "error") {
      ctx.ui.notify(`Schlop failed: ${outcome.message}`, "error");
    } else if (outcome.kind === "cancelled") {
      ctx.ui.notify("Schlop cancelled; nothing sent.", "info");
    } else if (!outcome.annotationCount) {
      ctx.ui.notify("No annotations; nothing sent.", "info");
    } else {
      pi.sendUserMessage(
        outcome.feedback,
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    }
  } finally {
    await request.cleanup();
  }
}

export default function schlop(pi: ExtensionAPI) {
  // Every command also answers to a short alias.
  const aliases: Record<string, string> = {
    "schlop-last": "sll",
    "schlop-message": "slm",
    "schlop-file": "slf",
  };
  const register: ExtensionAPI["registerCommand"] = (name, command) => {
    pi.registerCommand(name, command);
    pi.registerCommand(aliases[name]!, {
      ...command,
      description: `${command.description} (/${name})`,
    });
  };

  register("schlop-last", {
    description: "Annotate the last assistant message in Schlop (Neovim)",
    handler: async (_args, ctx) => {
      if (!requireTui("schlop-last", ctx)) return;
      const content = lastAssistantText(ctx.sessionManager.getBranch());
      if (!content) {
        ctx.ui.notify("No assistant message to annotate.", "warning");
        return;
      }
      await annotate(pi, ctx, content, "Last assistant message", "markdown");
    },
  });

  register("schlop-message", {
    description:
      "Pick an assistant message in the session tree and annotate it in Schlop (Neovim)",
    handler: async (_args, ctx) => {
      if (!requireTui("schlop-message", ctx)) return;
      const tree = ctx.sessionManager.getTree();
      if (!tree.length) {
        ctx.ui.notify("No messages in this session.", "warning");
        return;
      }
      // Loaded on use: Pi provides the module to extensions at runtime.
      const { TreeSelectorComponent } =
        await import("@earendil-works/pi-coding-agent");
      // The same selector as /tree, starting on the last assistant message.
      let selected = lastAssistantEntry(ctx.sessionManager.getBranch())?.id;
      for (;;) {
        const initial = selected;
        const entryId = await ctx.ui.custom<string | null>(
          (tui, _theme, _keybindings, done) =>
            new TreeSelectorComponent(
              tree,
              ctx.sessionManager.getLeafId(),
              tui.terminal.rows,
              (id) => done(id),
              () => done(null),
              undefined,
              initial,
              "no-tools",
            ),
        );
        if (entryId === null) return;
        const content = assistantText(ctx.sessionManager.getEntry(entryId));
        if (content) {
          await annotate(pi, ctx, content, "Assistant message", "markdown");
          return;
        }
        ctx.ui.notify("Pick an assistant message with text.", "warning");
        selected = entryId;
      }
    },
  });

  register("schlop-file", {
    description: "Annotate a file in Schlop (Neovim): /schlop-file <path>",
    getArgumentCompletions: (prefix) => pathCompletions(prefix, process.cwd()),
    handler: async (args, ctx) => {
      if (!requireTui("schlop-file", ctx)) return;
      const file = await readAnnotatableFile(args, ctx.cwd ?? process.cwd());
      if ("error" in file) {
        ctx.ui.notify(file.error, "error");
        return;
      }
      await annotate(pi, ctx, file.content, file.title, file.kind);
    },
  });
}
