import { expect, mock, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestSurface, loadRequest } from "@schlop/annotation-protocol";
import {
  lastAssistantText,
  pathCompletions,
  prepareRequest,
  readAnnotatableFile,
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
  formattedFeedback: "The user added comments:\\n\\n## 1. Line 1\\n\\n> Ship it.\\n\\nWhy?\\n",
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
        if (name === "schlop-last") handler = command.handler;
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

test("files become text or markdown requests titled by cwd-relative path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  try {
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "plan.md"), "# Plan\n");
    await writeFile(join(directory, "main.ts"), "let x = 1;\n");
    await writeFile(join(directory, "blob.bin"), Buffer.from([0xff, 0xfe]));
    expect(await readAnnotatableFile("docs/plan.md", directory)).toEqual({
      kind: "markdown",
      title: "docs/plan.md",
      content: "# Plan\n",
    });
    expect(await readAnnotatableFile(`@"main.ts"`, directory)).toEqual({
      kind: "text",
      title: "main.ts",
      content: "let x = 1;\n",
    });
    const outside = await readAnnotatableFile(
      join(directory, "main.ts"),
      join(directory, "docs"),
    );
    expect("title" in outside && outside.title).toBe(
      join(directory, "main.ts"),
    );
    expect(await readAnnotatableFile("", directory)).toHaveProperty("error");
    expect(await readAnnotatableFile("missing", directory)).toEqual({
      error: "File not found: missing",
    });
    expect(await readAnnotatableFile("docs", directory)).toHaveProperty(
      "error",
    );
    expect(await readAnnotatableFile("blob.bin", directory)).toHaveProperty(
      "error",
    );

    const request = await prepareRequest("let x = 1;\n", "main.ts", "text");
    try {
      const loaded = await loadRequest(request.requestPath);
      expect(createRequestSurface(loaded).kind).toBe("text");
    } finally {
      await request.cleanup();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path completions list directories first and descend into them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  try {
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "plan.md"), "");
    await writeFile(join(directory, "deploy.sh"), "");
    await writeFile(join(directory, ".hidden"), "");
    expect(await pathCompletions("d", directory)).toEqual([
      { value: "docs/", label: "docs/" },
      { value: "deploy.sh", label: "deploy.sh" },
    ]);
    expect(await pathCompletions("docs/p", directory)).toEqual([
      { value: "docs/plan.md", label: "plan.md" },
    ]);
    expect(await pathCompletions(".h", directory)).toEqual([
      { value: ".hidden", label: ".hidden" },
    ]);
    expect(await pathCompletions("nope/", directory)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("/schlop-file sends the file's annotations and reports bad paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  const binary = join(directory, "schlop");
  // The fake records the request it received, then submits one annotation.
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const request = JSON.parse(await Bun.file(process.argv[3]).text());
await Bun.write(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify({
  surface: request.surface,
  content: await Bun.file(request.surface.contentPath).text(),
}));
await Bun.write(request.resultPath, JSON.stringify({
  schemaVersion: 1, requestId: request.requestId, outcome: "submitted",
  annotations: [{ body: "Rename" }],
  formattedFeedback: "The user added comments:\\n\\n## 1. \\\`src/a.ts: line 1\\\`\\n",
}));
`,
  );
  await chmod(binary, 0o755);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "a.ts"), "const a = 1;\n");
  const previous = process.env.SCHLOP_BIN;
  process.env.SCHLOP_BIN = binary;
  try {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sent: unknown[][] = [];
    const notices: string[] = [];
    schlop({
      registerCommand: (name, command) => {
        if (name === "schlop-file") handler = command.handler;
      },
      sendUserMessage: (...args) => void sent.push(args),
    });
    const tui = { stop() {}, start() {}, requestRender() {} };
    const ctx = {
      mode: "tui",
      cwd: directory,
      isIdle: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        notify: (message: string) => notices.push(message),
        custom: (factory: any) =>
          new Promise((done) => factory(tui, undefined, undefined, done)),
      },
    };
    await handler!("missing.ts", ctx);
    expect(notices).toEqual(["File not found: missing.ts"]);
    expect(sent).toEqual([]);

    notices.length = 0;
    await handler!("src/a.ts", ctx);
    expect(notices).toEqual([]);
    const seen = JSON.parse(
      await readFile(join(directory, "seen.json"), "utf8"),
    );
    expect(seen.surface.kind).toBe("text");
    expect(seen.surface.title).toBe("src/a.ts");
    expect(seen.content).toBe("const a = 1;\n");
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toContain("`src/a.ts: line 1`");
    expect(sent[0]![1]).toEqual({ deliverAs: "followUp" });
  } finally {
    if (previous === undefined) delete process.env.SCHLOP_BIN;
    else process.env.SCHLOP_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

// A stand-in for Pi's /tree selector that picks the queued entry ids in turn.
const picks: (string | null)[] = [];
const selectorCalls: {
  leaf: string | null;
  initial?: string;
  filter?: string;
}[] = [];
mock.module("@earendil-works/pi-coding-agent", () => ({
  TreeSelectorComponent: class {
    constructor(
      _tree: unknown[],
      leaf: string | null,
      _rows: number,
      onSelect: (id: string) => void,
      onCancel: () => void,
      _onLabel?: unknown,
      initial?: string,
      filter?: string,
    ) {
      selectorCalls.push({ leaf, initial, filter });
      const pick = picks.shift() ?? null;
      queueMicrotask(() => (pick === null ? onCancel() : onSelect(pick)));
    }
    render() {
      return [];
    }
    invalidate() {}
  },
}));

test("every command also registers its short alias", () => {
  const names: string[] = [];
  schlop({
    registerCommand: (name) => void names.push(name),
    sendUserMessage: () => {},
  });
  expect(names.sort()).toEqual(
    [
      "schlop-file",
      "schlop-last",
      "schlop-message",
      "slf",
      "sll",
      "slm",
    ].sort(),
  );
});

test("/schlop-message annotates the assistant message picked in the tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-pi-test-"));
  const binary = join(directory, "schlop");
  await writeFile(
    binary,
    `#!/usr/bin/env bun
const request = JSON.parse(await Bun.file(process.argv[3]).text());
await Bun.write(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify({
  title: request.surface.title,
  content: await Bun.file(request.surface.contentPath).text(),
}));
await Bun.write(request.resultPath, JSON.stringify({
  schemaVersion: 1, requestId: request.requestId, outcome: "submitted",
  annotations: [{ body: "Why?" }], formattedFeedback: "The user added comments:\\n",
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
    schlop({
      registerCommand: (name, command) => {
        if (name === "schlop-message") handler = command.handler;
      },
      sendUserMessage: (...args) => void sent.push(args),
    });
    const entries: Record<string, unknown> = {
      a1: { id: "a1", ...assistant("Older answer.") },
      u2: {
        id: "u2",
        type: "message",
        message: { role: "user", content: "Hi" },
      },
      a2: { id: "a2", ...assistant("Newest answer.") },
    };
    const tui = {
      terminal: { rows: 40 },
      stop() {},
      start() {},
      requestRender() {},
    };
    const ctx = {
      mode: "tui",
      isIdle: () => true,
      sessionManager: {
        getBranch: () => Object.values(entries),
        getTree: () => [{ entry: entries.a1, children: [] }],
        getLeafId: () => "a2",
        getEntry: (id: string) => entries[id],
      },
      ui: {
        notify: (message: string) => notices.push(message),
        custom: (factory: any) =>
          new Promise((done) => factory(tui, undefined, undefined, done)),
      },
    };
    // A user message first: warn and reopen the tree on it, then pick a1.
    picks.push("u2", "a1");
    await handler!("", ctx);
    expect(selectorCalls).toEqual([
      { leaf: "a2", initial: "a2", filter: "no-tools" },
      { leaf: "a2", initial: "u2", filter: "no-tools" },
    ]);
    expect(notices).toEqual(["Pick an assistant message with text."]);
    expect(
      JSON.parse(await readFile(join(directory, "seen.json"), "utf8")),
    ).toEqual({ title: "Assistant message", content: "Older answer." });
    expect(sent).toHaveLength(1);

    // Escaping the tree sends nothing.
    picks.push(null);
    await handler!("", ctx);
    expect(sent).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env.SCHLOP_BIN;
    else process.env.SCHLOP_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
