// Pi extension: /schlop-last opens the last assistant message in Schlop's
// Neovim frontend and sends the submitted annotations back as a user message.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  lastAssistantText,
  prepareRequest,
  readOutcome,
  resolveSchlop,
} from "./core";

// Structural subset of Pi's ExtensionAPI, so this package needs no Pi
// dependency to typecheck inside the Schlop workspace.
type Tui = {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
};
type CommandContext = {
  mode?: string;
  hasUI?: boolean;
  isIdle(): boolean;
  sessionManager: { getBranch(): unknown[] };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    custom<T>(
      factory: (
        tui: Tui,
        theme: unknown,
        keybindings: unknown,
        done: (value: T) => void,
      ) => { render(): string[]; invalidate(): void },
    ): Promise<T>;
  };
};
type ExtensionAPI = {
  registerCommand(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: CommandContext): Promise<void>;
    },
  ): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
};

const extensionDirectory = dirname(fileURLToPath(import.meta.url));

export default function schlop(pi: ExtensionAPI) {
  pi.registerCommand("schlop-last", {
    description: "Annotate the last assistant message in Schlop (Neovim)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== undefined ? ctx.mode !== "tui" : !ctx.hasUI) {
        ctx.ui.notify("/schlop-last requires Pi's interactive TUI.", "error");
        return;
      }
      const content = lastAssistantText(ctx.sessionManager.getBranch());
      if (!content) {
        ctx.ui.notify("No assistant message to annotate.", "warning");
        return;
      }
      const executable = resolveSchlop(process.env, extensionDirectory);
      if (!executable) {
        ctx.ui.notify(
          "Schlop executable not found. Put schlop on PATH or set SCHLOP_BIN.",
          "error",
        );
        return;
      }
      const request = await prepareRequest(content, "Last assistant message");
      try {
        // Schlop's Neovim needs the terminal to itself: suspend Pi's renderer,
        // run to completion, then restore and redraw.
        const launch = await ctx.ui.custom<{
          status: number | null;
          error?: string;
        }>((tui, _theme, _keybindings, done) => {
          tui.stop();
          process.stdout.write("\x1b[2J\x1b[H");
          const child = spawnSync(
            executable,
            ["--request", request.requestPath],
            { stdio: "inherit", env: process.env },
          );
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
    },
  });
}
