import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addAnnotation,
  createSession,
  deleteAnnotation,
  markDocumentInspected,
  targetContext,
  updateAnnotation,
  validateTarget,
  type Annotation,
} from "@schlop/annotation-core";
import { createTextSurface, normalizeText } from "@schlop/surface-text";
import { createMarkdownSurface } from "@schlop/surface-markdown";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import {
  completionExitCode,
  exportJson,
  exportMarkdown,
} from "@schlop/annotation-export";
import { SessionStore } from "@schlop/annotation-storage";
import { validateGuidedDiffOverlay } from "@schlop/overlay-protocol";
import {
  actionHints,
  buildReviewStream,
  darkTheme,
  initialTuiState,
  fitHints,
  isEnterKey,
  layoutForWidth,
  panesForLayout,
  reviewWindow,
  resolveKey,
  selectionBounds,
  tuiReducer,
} from "@schlop/tui-components";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const now = "2026-01-02T03:04:05.000Z";
function annotation(target: Annotation["target"]): Annotation {
  return {
    schemaVersion: 1,
    id: "a1",
    target,
    body: "Fix this",
    source: { kind: "human" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("text and markdown surfaces", () => {
  test("normalizes text and creates stable line fingerprints", () => {
    expect(normalizeText("\uFEFFone\r\ntwo\rthree")).toBe("one\ntwo\nthree");
    const first = createTextSurface({ content: "héllo\n\tworld", title: "x" });
    const second = createTextSurface({
      content: "héllo\r\n\tworld",
      title: "x",
    });
    expect(first.snapshotId).toBe(second.snapshotId);
    expect(first.documents[0]!.lines).toHaveLength(2);
    expect(first.documents[0]!.lines[1]!.content).toBe("\tworld");
  });
  test("extracts ATX markdown headings", () => {
    const surface = createMarkdownSurface({
      content: "# Plan\nbody\n### Later ###",
      title: "plan",
    });
    expect(
      surface.documents[0]!.headings.map((heading) => [
        heading.level,
        heading.text,
        heading.line,
      ]),
    ).toEqual([
      [1, "Plan", 1],
      [3, "Later", 3],
    ]);
  });
});

describe("annotation core", () => {
  test("validates all text targets and CRUD", () => {
    const surface = createTextSurface({
      content: "one\ntwo\nthree",
      title: "x",
    });
    const documentId = surface.documents[0]!.id;
    const range = {
      kind: "text-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId,
      startLine: 1,
      endLine: 2,
    };
    const target = {
      ...range,
      contextFingerprint: targetContext(surface, range),
    };
    expect(validateTarget(surface, target).valid).toBe(true);
    let session = addAnnotation(
      createSession(surface, { id: "s1", now }),
      annotation(target),
    );
    expect(session.annotations).toHaveLength(1);
    session = updateAnnotation(session, "a1", { body: "Why?" }, now);
    expect(session.annotations[0]!.body).toBe("Why?");
    session = markDocumentInspected(session, documentId, now);
    expect(session.progress.inspectedDocumentIds).toEqual([documentId]);
    session = deleteAnnotation(session, "a1", now);
    expect(session.annotations).toEqual([]);
    expect(
      validateTarget(surface, { ...range, surfaceSnapshotId: "wrong" }).valid,
    ).toBe(false);
    expect(
      validateTarget(surface, { ...range, startLine: 3, endLine: 2 }).valid,
    ).toBe(false);
    expect(
      validateTarget(surface, {
        kind: "document",
        surfaceSnapshotId: surface.snapshotId,
        documentId,
      }).valid,
    ).toBe(true);
    expect(
      validateTarget(surface, {
        kind: "surface",
        surfaceSnapshotId: surface.snapshotId,
      }).valid,
    ).toBe(true);
  });
  test("rejects changed context fingerprints and external annotations equally", () => {
    const surface = createTextSurface({ content: "one", title: "x" });
    const target = {
      kind: "text-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId: surface.documents[0]!.id,
      startLine: 1,
      endLine: 1,
      contextFingerprint: "bad",
    };
    expect(validateTarget(surface, target).errors).toContain(
      "Target context fingerprint does not match",
    );
    expect(() =>
      addAnnotation(createSession(surface, { now }), {
        ...annotation(target),
        source: { kind: "external", name: "lint" },
      }),
    ).toThrow();
  });
});

const patch = `diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,3 +1,3 @@ heading\n same\n-old\n+new ✓\n last\n\\ No newline at end of file\ndiff --git a/image.bin b/image.bin\nnew file mode 100644\nBinary files /dev/null and b/image.bin differ\n`;
describe("diff surfaces", () => {
  test("parses rename, binary, sides, unicode, and missing newline", () => {
    const surface = parseUnifiedDiff(patch);
    expect(surface.documents.map((item) => item.status)).toEqual([
      "renamed",
      "binary",
    ]);
    const document = surface.documents[0]!;
    expect(document.additions).toBe(1);
    expect(document.deletions).toBe(1);
    expect(document.hunks[0]!.lines.at(-1)!.noNewline).toBe(true);
    const deletion = document.hunks[0]!.lines.find(
      (line) => line.kind === "deletion",
    )!;
    const target = {
      kind: "diff-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId: document.id,
      hunkId: document.hunks[0]!.id,
      side: "old" as const,
      startLine: deletion.oldLine!,
      endLine: deletion.oldLine!,
    };
    expect(validateTarget(surface, target).valid).toBe(true);
    expect(
      validateTarget(surface, {
        ...target,
        side: "new",
        startLine: 99,
        endLine: 99,
      }).valid,
    ).toBe(false);
    expect(parseUnifiedDiff(patch).snapshotId).toBe(surface.snapshotId);
    const session = addAnnotation(
      createSession(surface, { id: "d1", now }),
      annotation({
        ...target,
        contextFingerprint: targetContext(surface, target),
      }),
    );
    expect(exportMarkdown(session)).toContain(
      `(old)\`\n\n> ${deletion.content}\n\nFix this`,
    );
  });
  test("handles added, deleted and empty files", () => {
    const input = `diff --git a/a b/a\nnew file mode 100644\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+x\ndiff --git a/b b/b\ndeleted file mode 100644\n--- a/b\n+++ /dev/null\n@@ -1 +0,0 @@\n-y\ndiff --git a/e b/e\nnew file mode 100644\n--- /dev/null\n+++ b/e\n`;
    expect(
      parseUnifiedDiff(input).documents.map((item) => item.status),
    ).toEqual(["added", "deleted", "added"]);
  });
});

describe("exports, storage, overlays, and UI reducers", () => {
  test("lists annotations with locations in markdown and emits versioned JSON", () => {
    const surface = createTextSurface({ content: "one", title: "README.md" });
    const target = {
      kind: "text-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId: surface.documents[0]!.id,
      startLine: 1,
      endLine: 1,
    };
    const session = addAnnotation(
      createSession(surface, { id: "s1", now }),
      annotation(target),
    );
    expect(exportMarkdown(session)).toContain(
      "## 1. `README.md: line 1`\n\n> one\n\nFix this",
    );
    const partial = addAnnotation(
      createSession(surface, { id: "s2", now }),
      annotation({ ...target, startColumn: 2, endColumn: 3 }),
    );
    expect(exportMarkdown(partial)).toContain(
      "## 1. `README.md: line 1, columns 2-3`\n\n> ne\n\nFix this",
    );
    expect(JSON.parse(exportJson(session)).schemaVersion).toBe(1);
  });
  test("atomically saves, resumes, lists and survives corrupt neighbors", async () => {
    const root = await mkdtemp(join(tmpdir(), "schlop-test-"));
    temporary.push(root);
    const store = new SessionStore(root);
    const session = createSession(
      createTextSurface({ content: "x", title: "x" }),
      { id: "s1", now },
    );
    await store.save(session);
    expect((await store.load("s1")).surface.snapshotId).toBe(
      session.surface.snapshotId,
    );
    await writeFile(join(root, "sessions", "bad.json"), "{");
    const list = await store.list();
    expect(list.some((item) => "corrupt" in item)).toBe(true);
    expect((await store.mostRecent())?.id).toBe("s1");
    expect(await readFile(join(root, "sessions", "s1.json"), "utf8")).toContain(
      '"schemaVersion": 1',
    );
  });
  test("strictly validates guided overlay references", () => {
    const surface = parseUnifiedDiff(patch);
    const document = surface.documents[0]!;
    const value = {
      schemaVersion: 1,
      id: "g",
      kind: "guided-diff",
      surfaceSnapshotId: surface.snapshotId,
      summary: "Guide",
      sections: [
        {
          id: "s",
          title: "Start",
          overview: "",
          inspected: false,
          entries: [
            {
              documentId: document.id,
              summary: "Read",
              hunkIds: [document.hunks[0]!.id],
            },
          ],
        },
      ],
    };
    expect(validateGuidedDiffOverlay(value, surface).id).toBe("g");
    expect(() =>
      validateGuidedDiffOverlay(
        { ...value, surfaceSnapshotId: "bad" },
        surface,
      ),
    ).toThrow();
  });
  test("maps every completion outcome to a documented exit code", () => {
    expect([
      completionExitCode("submitted"),
      completionExitCode("cancelled"),
      completionExitCode("error"),
    ]).toEqual([0, 20, 1]);
  });
  test("resolves mnemonic chords without falling through to destructive commands", () => {
    const prefix = resolveKey(initialTuiState, { name: "]" });
    expect(prefix.action).toBeUndefined();
    expect(prefix.state.pendingChord).toBe("]");
    const nextDocument = resolveKey(prefix.state, { name: "d" });
    expect(nextDocument.action).toBe("next-document");
    expect(nextDocument.state.pendingChord).toBeUndefined();
    const invalidPrefix = resolveKey(prefix.state, { name: "x" });
    expect(invalidPrefix.action).toBeUndefined();
    expect(invalidPrefix.state.pendingChord).toBeUndefined();
    expect(resolveKey(initialTuiState, { name: "g", shift: true }).action).toBe(
      "bottom",
    );
    expect(resolveKey(initialTuiState, { name: "q" }).action).toBe("back");
    const headingPrefix = resolveKey(initialTuiState, { name: "]" });
    expect(resolveKey(headingPrefix.state, { name: "h" }).action).toBe(
      "next-heading",
    );
  });
  test("derives contextual footer hints from the same action registry as dispatch", () => {
    expect(actionHints(initialTuiState).join(" ")).toContain(
      "]d next document",
    );
    expect(actionHints(initialTuiState)).toContain("r finish");
    expect(
      actionHints({ ...initialTuiState, pane: "annotations" }).join(" "),
    ).toContain("d delete");
    expect(
      actionHints({ ...initialTuiState, mode: "compose" }).join(" "),
    ).toContain("Ctrl-s save comment");
  });
  test("selects annotations explicitly and clamps navigation", () => {
    let state = tuiReducer(initialTuiState, {
      type: "move-annotation",
      delta: 1,
      annotationCount: 3,
    });
    expect(state).toMatchObject({ pane: "annotations", annotationIndex: 1 });
    state = tuiReducer(state, {
      type: "move-annotation",
      delta: 20,
      annotationCount: 3,
    });
    expect(state.annotationIndex).toBe(2);
    state = tuiReducer(state, {
      type: "set-navigator",
      index: 4,
      itemCount: 5,
    });
    expect(state.navigatorIndex).toBe(4);
    state = tuiReducer(state, { type: "set-mode", mode: "confirm-delete" });
    expect(state.mode).toBe("confirm-delete");
  });
  test("builds a continuous semantic diff stream with inline annotations", () => {
    const surface = parseUnifiedDiff(patch);
    const document = surface.documents[0]!;
    const deletion = document.hunks[0]!.lines.find(
      (line) => line.kind === "deletion",
    )!;
    const target = {
      kind: "diff-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId: document.id,
      hunkId: document.hunks[0]!.id,
      side: "old" as const,
      startLine: deletion.oldLine!,
      endLine: deletion.oldLine!,
    };
    const session = addAnnotation(
      createSession(surface, { id: "stream", now }),
      annotation(target),
    );
    const stream = buildReviewStream(session, "new");
    expect(stream.map((item) => item.kind)).toEqual([
      "file-header",
      "hunk-header",
      "line",
      "line",
      "annotation",
      "line",
      "line",
      "file-header",
      "empty",
    ]);
    expect(
      stream.find(
        (item) => item.kind === "line" && item.lineKind === "deletion",
      ),
    ).toMatchObject({ oldLine: 2, marker: "-" });
    expect(stream.find((item) => item.kind === "annotation")).toMatchObject({
      annotationId: "a1",
    });
    const window = reviewWindow(stream, 4, 5);
    expect(
      window.items.reduce(
        (height, item) => height + (item.kind === "annotation" ? 2 : 1),
        0,
      ),
    ).toBeLessThanOrEqual(5);
    expect(window.items).toContain(stream[4]!);
  });
  test("uses a semantic theme and hides inactive empty annotation chrome", () => {
    expect(darkTheme.diff.addition.background).not.toBe(
      darkTheme.diff.deletion.background,
    );
    expect(darkTheme.diff.addition.marker).toBe("+");
    expect(darkTheme.diff.deletion.marker).toBe("-");
    expect(panesForLayout("wide", "content", 0)).toEqual([
      "documents",
      "content",
    ]);
    expect(panesForLayout("wide", "annotations", 2)).toEqual([
      "annotations",
      "content",
    ]);
    expect(panesForLayout("narrow", "content", 2)).toEqual(["content"]);
  });
  test("accepts both terminal names for the Enter key", () => {
    expect(isEnterKey("enter")).toBe(true);
    expect(isEnterKey("return")).toBe(true);
    expect(isEnterKey("space")).toBe(false);
  });
  test("fits contextual hints without truncating a shortcut", () => {
    expect(fitHints(["Ready", "j/k move", "]d next document"], 22)).toBe(
      "Ready · j/k move",
    );
    expect(fitHints(["long-unbreakable-hint"], 5)).toBe("");
  });
  test("handles selection, pane navigation and responsive widths", () => {
    let state = tuiReducer(initialTuiState, { type: "select" });
    state = tuiReducer(state, { type: "move-row", delta: 2, rowCount: 5 });
    expect(selectionBounds(state.selection, 0)).toEqual([0, 2]);
    expect(tuiReducer(state, { type: "next-pane" }).pane).toBe("annotations");
    expect([
      layoutForWidth(50),
      layoutForWidth(80),
      layoutForWidth(120),
    ]).toEqual(["narrow", "medium", "wide"]);
  });
});
