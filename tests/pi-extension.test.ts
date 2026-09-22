import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestSurface, loadRequest } from "@schlop/annotation-protocol";
import {
  formatFeedback,
  lastAssistantText,
  prepareRequest,
  readOutcome,
  resolveSchlop,
} from "../integrations/pi/core";
import schlop from "../integrations/pi/index";

const assistant = (text: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("last assistant text skips tool-only and user entries", () => {
  const branch = [
    assistant("first"),
    assistant("second"),
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall" }] },
    },
    { type: "message", message: { role: "user", content: "hello" } },
    { type: "compaction" },
  ];
  expect(lastAssistantText(branch)).toBe("second");
  expect(lastAssistantText([])).toBeNull();
});

test("prepared request is accepted by Schlop's request protocol", async () => {
  const content = "# Plan\n\nDo the thing.\n";
  const request = await prepareRequest(content, "Last assistant message");
  try {
    const loaded = await loadRequest(request.requestPath);
    expect(loaded.content).toBe(content);
    expect(loaded.request.requestId).toBe(request.requestId);
    expect(loaded.request.resultPath).toBe(request.resultPath);
    expect(createRequestSurface(loaded).kind).toBe("markdown");
  } finally {
    await request.cleanup();
  }
  expect(readFile(request.requestPath)).rejects.toThrow();
});

test("outcomes map result files and exit statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  const path = join(directory, "result.json");
  try {
    expect(await readOutcome(path, "r", 130)).toEqual({ kind: "cancelled" });
    expect((await readOutcome(path, "r", 1)).kind).toBe("error");
    const write = (value: unknown) => writeFile(path, JSON.stringify(value));
    await write({ schemaVersion: 1, requestId: "other", outcome: "cancelled" });
    expect((await readOutcome(path, "r", 0)).kind).toBe("error");
    await write({ schemaVersion: 1, requestId: "r", outcome: "cancelled" });
    expect(await readOutcome(path, "r", 20)).toEqual({ kind: "cancelled" });
    await write({
      schemaVersion: 1,
      requestId: "r",
      outcome: "error",
      error: { code: "x", message: "boom" },
    });
    expect(await readOutcome(path, "r", 1)).toEqual({
      kind: "error",
      message: "boom",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("feedback quotes the annotated lines or the selected part of them", () => {
  const feedback = formatFeedback("# Plan\r\n\r\nDo the thing.\r\nThen stop.", [
    {
      body: "Be specific.\n",
      target: { kind: "text-range", startLine: 3, endLine: 4 },
    },
    { body: "Overall fine.", target: { kind: "surface" } },
    {
      body: "Which?",
      target: {
        kind: "text-range",
        startLine: 3,
        endLine: 3,
        startColumn: 4,
        endColumn: 12,
      },
    },
    {
      body: "Spans lines.",
      target: {
        kind: "text-range",
        startLine: 3,
        endLine: 4,
        startColumn: 8,
        endColumn: 4,
      },
    },
  ]);
  expect(feedback).toContain(
    "## 1. Lines 3-4\n\n> Do the thing.\n> Then stop.\n\nBe specific.\n",
  );
  expect(feedback).toContain("## 2. Whole message\n\nOverall fine.\n");
  expect(feedback).toContain(
    "## 3. Line 3, columns 4-12\n\n> the thing\n\nWhich?\n",
  );
  expect(feedback).toContain(
    "## 4. Lines 3-4 (partial)\n\n> thing.\n> Then\n\nSpans lines.\n",
  );
});

test("executable resolution prefers SCHLOP_BIN, then PATH, then the checkout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  try {
    const binary = join(directory, "schlop");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    expect(resolveSchlop({ SCHLOP_BIN: binary, PATH: "" }, "/x/y/z")).toBe(
      binary,
    );
    expect(resolveSchlop({ SCHLOP_BIN: "/missing" }, "/x/y/z")).toBeNull();
    expect(resolveSchlop({ PATH: directory }, "/x/y/z")).toBe(binary);
    expect(resolveSchlop({ PATH: "" }, "/x/y/z")).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Drives the registered command with a fake Pi and a fake schlop executable
// that plays the role of the user annotating line 1 and submitting.
test("/schlop-last sends submitted annotations as a user message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  const binary = join(directory, "schlop");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const request = JSON.parse(await Bun.file(process.argv[3]).text());
await Bun.write(request.resultPath, JSON.stringify({
  schemaVersion: 1, requestId: request.requestId, outcome: "submitted",
  annotations: [{ body: "Why?",
    target: { kind: "text-range", startLine: 1, endLine: 1 } }],
}));
`,
  );
  await chmod(binary, 0o755);
  const previous = process.env.SCHLOP_BIN;
  process.env.SCHLOP_BIN = binary;
  try {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: unknown[][] = [];
    const notices: string[] = [];
    const lifecycle: string[] = [];
    schlop({
      registerCommand: (name, command) => {
        expect(name).toBe("schlop-last");
        handler = command.handler;
      },
      sendUserMessage: (...args) => void sent.push(args),
    });
    const tui = {
      stop: () => lifecycle.push("stop"),
      start: () => lifecycle.push("start"),
      requestRender: () => lifecycle.push("render"),
    };
    await handler!("", {
      mode: "tui",
      isIdle: () => true,
      sessionManager: { getBranch: () => [assistant("Ship it.\nNow.")] },
      ui: {
        notify: (message: string) => notices.push(message),
        custom: (factory: any) =>
          new Promise((done) => factory(tui, undefined, undefined, done)),
      },
    });
    expect(notices).toEqual([]);
    expect(lifecycle).toEqual(["stop", "start", "render"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toContain("## 1. Line 1\n\n> Ship it.\n\nWhy?");
    expect(sent[0]![1]).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.SCHLOP_BIN;
    else process.env.SCHLOP_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
