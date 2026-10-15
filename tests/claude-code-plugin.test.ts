import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assistantMessages,
  handle,
  lastAssistantText,
  parseCommand,
  readAnnotatableFile,
} from "../integrations/claude-code/hooks/schlop";

const pluginRoot = resolve(import.meta.dir, "../integrations/claude-code");
const hookPath = join(pluginRoot, "hooks/schlop.ts");

test("only namespaced or bare schlop commands are handled", () => {
  expect(parseCommand("/schlop:schlop-file @src/a.ts ")).toEqual({
    name: "file",
    argument: "@src/a.ts",
  });
  expect(parseCommand("/schlop-file")).toEqual({ name: "file", argument: "" });
  expect(parseCommand("/schlop:schlop-last")).toEqual({ name: "last" });
  expect(parseCommand("/schlop:schlop-message 2")).toEqual({
    name: "message",
    argument: "2",
  });
  expect(parseCommand("/slf README.md")).toEqual({
    name: "file",
    argument: "README.md",
  });
  expect(parseCommand("/sll")).toEqual({ name: "last" });
  expect(parseCommand("/slm 2")).toEqual({ name: "message", argument: "2" });
  expect(parseCommand("/schlop-lastly")).toBeNull();
  expect(parseCommand("/sllx")).toBeNull();
  expect(parseCommand("please run /schlop-last")).toBeNull();
});

const line = (value: object) => JSON.stringify(value);
const assistant = (
  uuid: string,
  parentUuid: string | null,
  id: string,
  content: unknown[],
) => line({ type: "assistant", uuid, parentUuid, message: { id, content } });

test("last assistant text follows the active branch and joins split entries", () => {
  const transcript = [
    line({ type: "user", uuid: "u1", parentUuid: null, message: {} }),
    assistant("a1", "u1", "m1", [{ type: "text", text: "Old answer." }]),
    line({ type: "user", uuid: "u2", parentUuid: "a1", message: {} }),
    assistant("a2", "u2", "m2", [{ type: "thinking", thinking: "" }]),
    assistant("a3", "a2", "m2", [{ type: "text", text: "Part one." }]),
    assistant("a4", "a3", "m2", [{ type: "tool_use", id: "t" }]),
    line({ type: "user", uuid: "u3", parentUuid: "a4", message: {} }),
    assistant("a5", "u3", "m3", [{ type: "tool_use", id: "t2" }]),
    // A rewound branch: newer in the file, but not an ancestor of the tip.
    assistant("x1", "u2", "mx", [{ type: "text", text: "Abandoned." }]),
    line({ type: "attachment", uuid: "t1", parentUuid: "a5" }),
    line({ type: "mode" }),
    '{"type":"assist',
  ].join("\n");
  expect(lastAssistantText(transcript)).toBe("Part one.");
  expect(assistantMessages(transcript)).toEqual(["Old answer.", "Part one."]);

  const joined = [
    assistant("b1", null, "m1", [{ type: "text", text: "First." }]),
    assistant("b2", "b1", "m1", [{ type: "text", text: "Second." }]),
  ].join("\n");
  expect(lastAssistantText(joined)).toBe("First.\nSecond.");
  expect(lastAssistantText("")).toBeNull();
});

test("assistant messages reach back past a compaction boundary", () => {
  const transcript = [
    line({ type: "user", uuid: "u1", parentUuid: null, message: {} }),
    assistant("a1", "u1", "m1", [{ type: "text", text: "Before compaction." }]),
    line({
      type: "system",
      subtype: "compact_boundary",
      uuid: "c1",
      parentUuid: null,
      logicalParentUuid: "a1",
    }),
    line({
      type: "user",
      uuid: "s1",
      parentUuid: "c1",
      isCompactSummary: true,
      message: {},
    }),
  ].join("\n");
  expect(lastAssistantText(transcript)).toBe("Before compaction.");

  const after = `${transcript}\n${[
    line({ type: "user", uuid: "u2", parentUuid: "s1", message: {} }),
    assistant("a2", "u2", "m2", [{ type: "text", text: "After." }]),
  ].join("\n")}`;
  expect(assistantMessages(after)).toEqual(["Before compaction.", "After."]);
});

test("files accept @-mentions and are titled by cwd-relative path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "schlop-cc-test-"));
  try {
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs", "plan.md"), "# Plan\n");
    await writeFile(join(directory, "blob"), Buffer.from([0xff, 0xfe]));
    expect(await readAnnotatableFile("@docs/plan.md", directory)).toEqual({
      kind: "markdown",
      title: "docs/plan.md",
      content: "# Plan\n",
    });
    expect(await readAnnotatableFile("missing", directory)).toEqual({
      error: "File not found: missing",
    });
    expect(await readAnnotatableFile("blob", directory)).toHaveProperty(
      "error",
    );
    expect(await readAnnotatableFile("", directory)).toEqual({
      error: "Usage: /schlop-file <path>",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// A fake tmux runs the popup's command inline, and a fake schlop records the
// request and plays the user: it submits, cancels, or submits nothing.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "schlop-cc-test-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "tmux"),
    `#!/bin/sh\nfor last; do :; done\nexec "$last"\n`,
  );
  await writeFile(
    join(bin, "schlop"),
    `#!/usr/bin/env bun
const request = JSON.parse(await Bun.file(process.argv[3]).text());
await Bun.write(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify({
  surface: request.surface,
  content: await Bun.file(request.surface.contentPath).text(),
}));
const mode = process.env.FAKE_SCHLOP;
if (mode === "cancel") process.exit(20);
await Bun.write(request.resultPath, JSON.stringify({
  schemaVersion: 1, requestId: request.requestId, outcome: "submitted",
  annotations: mode === "empty" ? [] : [{ body: "Rename" }],
  formattedFeedback: "The user added comments:\\n\\n## 1. \`src/a.ts: line 1\`\\n",
}));
`,
  );
  // Picks the row numbered FAKE_FZF_PICK, or exits 130 like Esc.
  await writeFile(
    join(bin, "fzf"),
    `#!/bin/sh\n[ -n "$FAKE_FZF_PICK" ] || exit 130\ngrep "^$FAKE_FZF_PICK\t"\n`,
  );
  await chmod(join(bin, "fzf"), 0o755);
  await chmod(join(bin, "tmux"), 0o755);
  await chmod(join(bin, "schlop"), 0o755);
  await mkdir(join(directory, "src"));
  await writeFile(join(directory, "src", "a.ts"), "const a = 1;\n");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TMUX: "/tmp/fake,1,0",
  };
  return { directory, env };
}

test("/schlop-file attaches submitted feedback and blocks everything else", async () => {
  const { directory, env } = await fixture();
  try {
    const input = { prompt: "/schlop:schlop-file src/a.ts", cwd: directory };
    expect(await handle(input, env, pluginRoot)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          "The user added comments:\n\n## 1. `src/a.ts: line 1`\n",
      },
    });
    const seen = JSON.parse(
      await Bun.file(join(directory, "seen.json")).text(),
    );
    expect(seen.surface).toMatchObject({ kind: "text", title: "src/a.ts" });
    expect(seen.content).toBe("const a = 1;\n");

    expect(
      await handle(input, { ...env, FAKE_SCHLOP: "cancel" }, pluginRoot),
    ).toEqual({ decision: "block", reason: "Schlop cancelled; nothing sent." });
    expect(
      await handle(input, { ...env, FAKE_SCHLOP: "empty" }, pluginRoot),
    ).toEqual({ decision: "block", reason: "No annotations; nothing sent." });
    expect(
      await handle(
        { prompt: "/schlop-file nope.ts", cwd: directory },
        env,
        pluginRoot,
      ),
    ).toEqual({ decision: "block", reason: "File not found: nope.ts" });
    expect(await handle(input, { PATH: env.PATH }, pluginRoot)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("tmux or herdr"),
    });
    expect(await handle({ prompt: "hello" }, env, pluginRoot)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the hook runs under plain Node and annotates the last message", async () => {
  const { directory, env } = await fixture();
  try {
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(
      transcriptPath,
      assistant("a1", null, "m1", [{ type: "text", text: "Ship it." }]),
    );
    const child = spawnSync("node", [hookPath], {
      input: JSON.stringify({
        prompt: "/schlop:schlop-last",
        cwd: directory,
        transcript_path: transcriptPath,
      }),
      env: { ...process.env, ...env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(
      JSON.parse(child.stdout).hookSpecificOutput.additionalContext,
    ).toContain("src/a.ts: line 1");
    const seen = JSON.parse(
      await Bun.file(join(directory, "seen.json")).text(),
    );
    expect(seen.surface).toMatchObject({
      kind: "markdown",
      title: "Last assistant message",
    });
    expect(seen.content).toBe("Ship it.");

    const silent = spawnSync("node", [hookPath], {
      input: JSON.stringify({ prompt: "hello" }),
      encoding: "utf8",
    });
    expect(silent.status).toBe(0);
    expect(silent.stdout).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("/schlop-message picks among assistant messages, newest first", async () => {
  const { directory, env } = await fixture();
  try {
    const transcriptPath = join(directory, "session.jsonl");
    await writeFile(
      transcriptPath,
      [
        assistant("a1", null, "m1", [{ type: "text", text: "# First\nBody" }]),
        line({ type: "user", uuid: "u1", parentUuid: "a1", message: {} }),
        assistant("a2", "u1", "m2", [{ type: "text", text: "Second" }]),
        line({ type: "user", uuid: "u2", parentUuid: "a2", message: {} }),
        assistant("a3", "u2", "m3", [{ type: "text", text: "Third" }]),
      ].join("\n"),
    );
    const input = (prompt: string) => ({
      prompt,
      cwd: directory,
      transcript_path: transcriptPath,
    });
    const seen = async () =>
      JSON.parse(await Bun.file(join(directory, "seen.json")).text());

    // Row 3 is the oldest message; the picker lists newest first.
    const picked = await handle(
      input("/schlop:schlop-message"),
      { ...env, FAKE_FZF_PICK: "3" },
      pluginRoot,
    );
    expect(picked).toHaveProperty("hookSpecificOutput");
    expect(await seen()).toEqual({
      surface: expect.objectContaining({ title: "Assistant message" }),
      content: "# First\nBody",
    });

    expect(
      await handle(input("/schlop:schlop-message"), env, pluginRoot),
    ).toEqual({ decision: "block", reason: "Schlop cancelled; nothing sent." });

    // A number skips the picker, so it works without fzf.
    const noFzfBin = join(directory, "bin-no-fzf");
    await mkdir(noFzfBin);
    await symlink(join(directory, "bin", "tmux"), join(noFzfBin, "tmux"));
    await symlink(join(directory, "bin", "schlop"), join(noFzfBin, "schlop"));
    const noFzf = {
      TMUX: env.TMUX,
      PATH: `${noFzfBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    await handle(input("/schlop:schlop-message 2"), noFzf, pluginRoot);
    expect((await seen()).content).toBe("Second");
    expect(
      await handle(input("/schlop:schlop-message"), noFzf, pluginRoot),
    ).toEqual({
      decision: "block",
      reason: expect.stringContaining("needs fzf"),
    });
    expect(
      await handle(input("/schlop:schlop-message 9"), env, pluginRoot),
    ).toEqual({
      decision: "block",
      reason: "Usage: /schlop-message [n], where n is 1 (last) to 3",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
