import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSession } from "@schlop/annotation-core";
import { createTextSurface } from "@schlop/surface-text";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import { fingerprint } from "@schlop/surface-protocol";
import { loadRequest, validateResult } from "@schlop/annotation-protocol";
import { createResult } from "@schlop/annotation-export";
import {
  discoverRuntime,
  MINIMUM_NVIM,
  resolveNvim,
} from "../apps/cli/src/nvim";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);
async function root(name = "schlop test ") {
  const path = await mkdtemp(join(tmpdir(), name));
  roots.push(path);
  return path;
}
async function executable(path: string, body: string) {
  await writeFile(path, body, { mode: 0o700 });
  await chmod(path, 0o700);
}

describe("Neovim discovery", () => {
  test("uses explicit, config, environment, then PATH and validates identity/version", async () => {
    const directory = await root();
    const make = async (name: string, version: string) => {
      const path = join(directory, name);
      await executable(path, `#!/bin/sh\nprintf 'NVIM v${version}\\n'\n`);
      return path;
    };
    const explicit = await make("explicit nvim", "0.10.0");
    const configured = await make("configured", "0.11.0");
    const environment = await make("environment", "0.12.0");
    const pathNvim = await make("nvim", "0.9.0");
    const config = join(directory, "config.json");
    await writeFile(config, JSON.stringify({ nvim: configured }));
    const env = {
      SCHLOP_CONFIG: config,
      SCHLOP_NVIM: environment,
      PATH: directory,
    };
    expect((await resolveNvim(explicit, env)).path).toBe(explicit);
    expect((await resolveNvim(undefined, env)).path).toBe(configured);
    await writeFile(config, "{}");
    expect((await resolveNvim(undefined, env)).path).toBe(environment);
    expect(
      (
        await resolveNvim(undefined, {
          SCHLOP_CONFIG: join(directory, "missing"),
          PATH: directory,
        })
      ).path,
    ).toBe(pathNvim);
    const old = await make("old", "0.8.3");
    expect((await resolveNvim(old, env)).error).toBe("unsupported");
    const fake = join(directory, "fake");
    await executable(fake, "#!/bin/sh\necho editor\n");
    expect((await resolveNvim(fake, env)).error).toBe("not Neovim");
    expect(MINIMUM_NVIM).toBe("0.9.0");
  });

  test("discovers an explicit runtime in a path containing spaces", async () => {
    const directory = await root();
    await mkdir(join(directory, "lua", "schlop"), { recursive: true });
    await writeFile(
      join(directory, "lua", "schlop", "launch.lua"),
      "return {}",
    );
    await writeFile(join(directory, "lua", "schlop", "init.lua"), "return {}");
    expect(await discoverRuntime({ SCHLOP_RUNTIME: directory })).toBe(
      directory,
    );
  });
});

test("request protocol verifies private frozen content and snapshot", async () => {
  const directory = await root();
  const content = join(directory, "content.md");
  const result = join(directory, "result.json");
  const request = join(directory, "request.json");
  await writeFile(content, "# Frozen\n", { mode: 0o600 });
  await writeFile(
    request,
    JSON.stringify({
      schemaVersion: 1,
      requestId: "request-1",
      surface: {
        kind: "markdown",
        title: "Document",
        contentPath: content,
        snapshotId: fingerprint("# Frozen\n"),
      },
      source: { label: "host", metadata: { safe: true } },
      resultPath: result,
      options: { readOnly: true },
    }),
  );
  expect((await loadRequest(request)).content).toBe("# Frozen\n");
  await writeFile(content, "changed");
  await expect(loadRequest(request)).rejects.toThrow("snapshot identity");
});

test("result validation binds completion to the expected frozen session", () => {
  const surface = createTextSurface({ content: "one", title: "Expected" });
  const session = createSession(surface, { id: "expected-session" });
  const valid = createResult(session, "submitted", "expected-request");
  expect(
    validateResult(valid, { requestId: "expected-request", session }).sessionId,
  ).toBe(session.id);
  expect(() =>
    validateResult(
      { ...valid, sessionId: "stale-session" },
      { requestId: "expected-request", session },
    ),
  ).toThrow("session id");
  const invalidTarget = {
    ...valid,
    annotations: [
      {
        schemaVersion: 1,
        id: "bad",
        intent: "note",
        body: "bad target",
        source: { kind: "human" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        target: {
          kind: "text-range",
          surfaceSnapshotId: surface.snapshotId,
          documentId: "missing",
          startLine: 1,
          endLine: 1,
        },
      },
    ],
  };
  expect(() =>
    validateResult(invalidTarget, { requestId: "expected-request", session }),
  ).toThrow("Invalid result annotations");
});

test("controller owns annotation creation, approval and atomic result", async () => {
  const directory = await root();
  const surface = createTextSurface({ content: "one\ntwo", title: "Frozen" });
  const session = createSession(surface, { id: "controller-test" });
  const launch = join(directory, "launch.json");
  const result = join(directory, "result.json");
  await writeFile(
    launch,
    JSON.stringify({
      schemaVersion: 1,
      session,
      resultPath: result,
      requestId: "rpc-1",
    }),
  );
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../apps/cli/src/index.ts"),
      "__controller",
      launch,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SCHLOP_DATA_DIR: join(directory, "data") },
    },
  );
  const writer = child.stdin;
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  type TestResponse = {
    result: {
      annotations: Array<{
        id: string;
        body: string;
        target: { contextFingerprint?: string };
      }>;
    };
  };
  const response = async (): Promise<TestResponse> => {
    while (!buffered.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("Controller closed before replying");
      buffered += decoder.decode(next.value, { stream: true });
    }
    const newline = buffered.indexOf("\n");
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    return JSON.parse(line) as TestResponse;
  };
  writer.write(
    `${JSON.stringify({ id: 1, method: "addAnnotation", params: { target: { kind: "text-range", surfaceSnapshotId: surface.snapshotId, documentId: surface.documents[0]!.id, startLine: 1, endLine: 2 }, intent: "question", body: "Why?" } })}\n`,
  );
  const added = await response();
  const annotationId = added.result.annotations[0]!.id;
  expect(added.result.annotations[0]!.target.contextFingerprint).toMatch(
    /^sha256:/,
  );
  writer.write(
    `${JSON.stringify({ id: 2, method: "updateAnnotation", params: { id: annotationId, intent: "suggestion", body: "Edited" } })}\n`,
  );
  expect((await response()).result.annotations[0]!.body).toBe("Edited");
  writer.write(
    `${JSON.stringify({ id: 3, method: "deleteAnnotation", params: { id: annotationId } })}\n`,
  );
  expect((await response()).result.annotations).toHaveLength(0);
  writer.write(`${JSON.stringify({ id: 4, method: "approve" })}\n`);
  await response();
  writer.end();
  expect(await child.exited).toBe(0);
  const completion = JSON.parse(await readFile(result, "utf8"));
  expect(completion).toMatchObject({
    schemaVersion: 1,
    requestId: "rpc-1",
    outcome: "approved",
  });
  expect(completion.formattedFeedback).toBeUndefined();
});

test("headless Neovim renders an empty diff without crashing", async () => {
  if (!Bun.which("nvim")) return;
  const directory = await root();
  const session = createSession(parseUnifiedDiff(""), { id: "empty-diff" });
  const script = join(directory, "empty.lua");
  await writeFile(
    script,
    `
vim.opt.runtimepath:prepend(${JSON.stringify(join(import.meta.dir, "../nvim"))})
require("schlop.ui").open(vim.json.decode(${JSON.stringify(JSON.stringify(session))}), { standalone = false })
assert(vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == "(no changed documents)")
vim.api.nvim_feedkeys(vim.keycode("]f"), "x", false)
vim.cmd("qa!")
`,
  );
  const child = Bun.spawn(
    [Bun.which("nvim")!, "--headless", "-u", "NONE", "-l", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
});

test("Neovim UI recomputes its pane layout across resize breakpoints", async () => {
  if (!Bun.which("nvim")) return;
  const directory = await root();
  const session = createSession(
    createTextSurface({ content: "resize", title: "Resize" }),
    { id: "resize-layout" },
  );
  const script = join(directory, "resize.lua");
  await writeFile(
    script,
    `
vim.opt.runtimepath:prepend(${JSON.stringify(join(import.meta.dir, "../nvim"))})
vim.o.columns = 100
vim.o.wrap = false
require("schlop.ui").open(vim.json.decode(${JSON.stringify(JSON.stringify(session))}), { standalone = false })
assert(#vim.api.nvim_tabpage_list_wins(0) == 2)
vim.o.columns = 64
vim.api.nvim_exec_autocmds("VimResized", {})
assert(vim.wait(1000, function() return #vim.api.nvim_tabpage_list_wins(0) == 1 end, 20))
vim.api.nvim_feedkeys("?", "x", false)
assert(vim.api.nvim_win_get_config(0).relative == "editor")
assert(vim.wo.wrap and vim.wo.linebreak, "narrow help must wrap complete descriptions")
vim.api.nvim_feedkeys("?", "x", false)
vim.o.columns = 100
vim.api.nvim_exec_autocmds("VimResized", {})
assert(vim.wait(1000, function() return #vim.api.nvim_tabpage_list_wins(0) == 2 end, 20))
vim.cmd("qa!")
`,
  );
  const child = Bun.spawn(
    [Bun.which("nvim")!, "--headless", "-u", "NONE", "-l", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
});

test("CLI Neovim loads user configuration and exits when its controller fails", async () => {
  if (!Bun.which("nvim")) return;
  const directory = await root();
  const launch = join(directory, "broken.json");
  const marker = join(directory, "user-config-loaded");
  const configHome = join(directory, "config");
  await mkdir(join(configHome, "nvim"), { recursive: true });
  await writeFile(
    join(configHome, "nvim", "init.lua"),
    `vim.fn.writefile({ "loaded" }, ${JSON.stringify(marker)})`,
  );
  await writeFile(
    launch,
    JSON.stringify({
      schemaVersion: 1,
      input: { kind: "file", path: join(directory, "missing") },
    }),
  );
  const runtime = join(import.meta.dir, "../nvim");
  const child = Bun.spawn(
    [
      Bun.which("nvim")!,
      "--headless",
      "--cmd",
      "lua vim.opt.runtimepath:prepend(vim.env.SCHLOP_RUNTIME)",
      "-c",
      'lua require("schlop.launch").start()',
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SCHLOP_RUNTIME: runtime,
        SCHLOP_LAUNCH: launch,
        SCHLOP_CONTROLLER_COMMAND: JSON.stringify([
          process.execPath,
          join(import.meta.dir, "../apps/cli/src/index.ts"),
        ]),
        SCHLOP_STANDALONE: "1",
        XDG_CONFIG_HOME: configHome,
      },
    },
  );
  expect(await child.exited).not.toBe(0);
  expect(await Bun.file(marker).exists()).toBe(true);
});

test("headless Neovim renders old/new diff targets", async () => {
  if (!Bun.which("nvim")) return;
  const directory = await root();
  const surface = parseUnifiedDiff(
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-before\n+after\n",
  );
  const session = createSession(surface, { id: "nvim-diff" });
  const launch = join(directory, "launch.json");
  const result = join(directory, "result.json");
  const script = join(directory, "diff.lua");
  const document = surface.documents[0]!;
  const hunk = document.hunks[0]!;
  await writeFile(
    launch,
    JSON.stringify({ schemaVersion: 1, session, resultPath: result }),
  );
  await writeFile(
    script,
    `
vim.opt.runtimepath:prepend(${JSON.stringify(join(import.meta.dir, "../nvim"))})
require("schlop.bootstrap").start(${JSON.stringify(launch)}, { standalone = false })
assert(vim.wait(5000, function() return vim.api.nvim_buf_get_name(0):match("^schlop://") ~= nil end, 20))
local content = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n")
assert(content:match("%- old") and content:match("%+ new"))
assert(vim.wo.winbar:match("a.txt") and vim.wo.winbar:match("1/2"), "winbar must identify the current file")
assert(vim.wo.statusline:match("%[f/%]f files") and vim.wo.statusline:match("c annotate") and vim.wo.statusline:match("s submit") and vim.wo.statusline:match("? help"), "statusline must expose the primary shortcut legend")
vim.api.nvim_feedkeys(vim.keycode("]f"), "x", false)
assert(vim.wait(1000, function() return vim.wo.winbar:match("b.ts") and vim.wo.winbar:match("2/2") end, 20), "next-file mapping must update visible identity")
vim.api.nvim_feedkeys(vim.keycode("[f"), "x", false)
local common = { surfaceSnapshotId = ${JSON.stringify(surface.snapshotId)}, documentId = ${JSON.stringify(document.id)}, hunkId = ${JSON.stringify(hunk.id)} }
local old_target = vim.tbl_extend("force", common, { kind = "diff-range", side = "old", startLine = 1, endLine = 1 })
local new_target = vim.tbl_extend("force", common, { kind = "diff-range", side = "new", startLine = 1, endLine = 1 })
require("schlop.rpc").call("addAnnotation", { target = old_target, intent = "note", body = "old side" }, function(old_error)
  assert(not old_error)
  require("schlop.rpc").call("addAnnotation", { target = new_target, intent = "note", body = "new side" }, function(new_error)
    assert(not new_error)
    require("schlop.rpc").call("submit", {}, function(submit_error) assert(not submit_error); vim.g.done = true end)
  end)
end)
assert(vim.wait(5000, function() return vim.g.done == true end, 20))
vim.cmd("qa!")
`,
  );
  const child = Bun.spawn(
    [Bun.which("nvim")!, "--headless", "-u", "NONE", "-l", script],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SCHLOP_CONTROLLER_COMMAND: JSON.stringify([
          process.execPath,
          join(import.meta.dir, "../apps/cli/src/index.ts"),
        ]),
        SCHLOP_DATA_DIR: join(directory, "data"),
      },
    },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  const completion = JSON.parse(await readFile(result, "utf8"));
  expect(
    completion.annotations.map(
      (item: { target: { side: string } }) => item.target.side,
    ),
  ).toEqual(["old", "new"]);
});

test("headless Neovim opens immutable plugin surface and submits without exiting", async () => {
  if (!Bun.which("nvim")) return;
  const directory = await root();
  const surface = createTextSurface({
    content: "immutable ".repeat(20_000),
    title: "Neovim",
  });
  const session = createSession(surface, { id: "nvim-test" });
  const launch = join(directory, "launch.json");
  const result = join(directory, "result.json");
  const script = join(directory, "test.lua");
  await writeFile(
    launch,
    JSON.stringify({ schemaVersion: 1, session, resultPath: result }),
  );
  await writeFile(
    script,
    `
vim.opt.runtimepath:prepend(${JSON.stringify(join(import.meta.dir, "../nvim"))})
require("schlop.bootstrap").start(${JSON.stringify(launch)}, { standalone = false })
assert(vim.wait(5000, function() return vim.api.nvim_buf_get_name(0):match("^schlop://") ~= nil end, 20))
assert(vim.bo.buftype == "nofile" and vim.bo.readonly and not vim.bo.modifiable and not vim.bo.modeline and not vim.bo.swapfile)
vim.api.nvim_feedkeys("c", "x", false)
assert(vim.api.nvim_win_get_config(0).relative == "editor")
vim.api.nvim_buf_set_lines(0, 0, -1, false, { "created through composer" })
vim.api.nvim_feedkeys(vim.keycode("<C-s>"), "x", false)
assert(vim.wait(5000, function() return vim.api.nvim_buf_get_name(0):match("^schlop://") ~= nil end, 20))
assert(vim.fn.mode() == "n", "composer must restore Normal mode")
vim.api.nvim_feedkeys(vim.keycode("<Tab>"), "x", false)
assert(vim.wait(5000, function() return vim.fn.search("created through composer") > 0 end, 20))
vim.api.nvim_feedkeys("e", "x", false)
assert(vim.api.nvim_win_get_config(0).relative == "editor")
assert(vim.fn.mode():match("^[sS]"), "edit composer must select the existing body")
vim.api.nvim_feedkeys("edited through composer", "x", false)
vim.api.nvim_feedkeys(vim.keycode("<C-s>"), "x", false)
assert(vim.wait(5000, function() return vim.fn.mode() == "n" end, 20))
vim.api.nvim_feedkeys("s", "x", false)
local uv = vim.uv or vim.loop
assert(vim.wait(5000, function() return uv.fs_stat(${JSON.stringify(result)}) ~= nil end, 20))
assert(vim.v.exiting == vim.NIL or vim.v.exiting == 0)
vim.cmd("qa!")
`,
  );
  const child = Bun.spawn(
    [Bun.which("nvim")!, "--headless", "-u", "NONE", "-l", script],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        SCHLOP_CONTROLLER_COMMAND: JSON.stringify([
          process.execPath,
          join(import.meta.dir, "../apps/cli/src/index.ts"),
        ]),
        SCHLOP_DATA_DIR: join(directory, "data"),
      },
    },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited, stderr).toBe(0);
  expect(JSON.parse(await readFile(result, "utf8"))).toMatchObject({
    outcome: "submitted",
    annotations: [{ body: "edited through composer" }],
  });
});
