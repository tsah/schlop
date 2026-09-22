import { describe, expect, test } from "bun:test";
import React, { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import {
  addAnnotation,
  createSession,
  targetContext,
} from "@schlop/annotation-core";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import { initialTuiState, type TuiState } from "@schlop/tui-components";
import { App } from "../apps/tui/src/app";

const patch = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,4 @@ function run()
 const value = 1
-const oldName = value
+const newName = value
+validate(newName)
 return value
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-Old title
+New title
`;

async function renderAt(
  width: number,
  height: number,
  withAnnotation = false,
  initialView?: TuiState,
) {
  const surface = parseUnifiedDiff(patch);
  let session = createSession(surface, {
    id: `visual-${width}`,
    now: "2026-01-02T03:04:05.000Z",
  });
  if (withAnnotation) {
    const document = surface.documents[0]!;
    const hunk = document.hunks[0]!;
    const addition = hunk.lines.find((line) => line.kind === "addition")!;
    const target = {
      kind: "diff-range" as const,
      surfaceSnapshotId: surface.snapshotId,
      documentId: document.id,
      hunkId: hunk.id,
      side: "new" as const,
      startLine: addition.newLine!,
      endLine: addition.newLine!,
    };
    session = addAnnotation(session, {
      schemaVersion: 1,
      id: "visual-comment",
      target: { ...target, contextFingerprint: targetContext(surface, target) },
      body: "Explain this rename before shipping.",
      source: { kind: "human" },
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  }
  let setup: Awaited<ReturnType<typeof testRender>> | undefined;
  await act(async () => {
    setup = await testRender(
      <App
        initial={session}
        stale={false}
        initialView={initialView}
        onSave={async () => {}}
        finish={() => {}}
      />,
      { width, height },
    );
    await setup.flush();
  });
  return setup!;
}

describe("polished TUI frames", () => {
  for (const width of [60, 80, 120, 180]) {
    test(`review frame at ${width} columns`, async () => {
      const setup = await renderAt(width, 30);
      try {
        expect(setup.captureCharFrame()).toMatchSnapshot();
      } finally {
        await act(async () => setup.renderer.destroy());
      }
    });
  }

  test("the main review pane shows only the navigator's active file", async () => {
    const setup = await renderAt(120, 30);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("src/new.ts [R]");
      expect(frame).not.toContain("Old title");
      expect(frame).not.toContain("New title");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("semantic diff rows use distinct full-row backgrounds", async () => {
    const setup = await renderAt(120, 30);
    try {
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const addition = spans.find((span) => span.text.includes("newName"));
      const deletion = spans.find((span) => span.text.includes("oldName"));
      expect(addition).toBeDefined();
      expect(deletion).toBeDefined();
      expect(addition!.bg.toString()).not.toBe(deletion!.bg.toString());
      const deletionLine = setup
        .captureSpans()
        .lines.find((line) =>
          line.spans.some((span) => span.text.includes("oldName")),
        )!;
      const deletionBackgroundWidth = deletionLine.spans
        .filter((span) => span.bg.toString() === deletion!.bg.toString())
        .reduce((width, span) => width + span.width, 0);
      expect(deletionBackgroundWidth).toBeGreaterThanOrEqual(85);
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("inline annotations do not open a permanent comments pane", async () => {
    const setup = await renderAt(120, 30, true);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Explain this rename before shipping.");
      expect(frame).not.toContain("Comments · 1");
      expect(frame).toContain("Files · 2");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("inline annotations stay in the review stream and comments mode replaces the navigator", async () => {
    const setup = await renderAt(120, 30, true, {
      ...initialTuiState,
      pane: "annotations",
    });
    try {
      const commentsFrame = setup.captureCharFrame();
      expect(commentsFrame).toContain("COMMENTS");
      expect(commentsFrame).toContain("Comments · 1");
      expect(commentsFrame).toContain("Explain this rename before shipping.");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("mode footer changes for visual selection and composition", async () => {
    const visual = await renderAt(120, 30, false, {
      ...initialTuiState,
      selection: { anchor: 0, focus: 2 },
    });
    try {
      expect(visual.captureCharFrame()).toContain("VISUAL");
    } finally {
      await act(async () => visual.renderer.destroy());
    }
    const compose = await renderAt(120, 30, false, {
      ...initialTuiState,
      mode: "compose",
      composing: true,
    });
    try {
      const frame = compose.captureCharFrame();
      expect(frame).toContain("COMPOSE");
      expect(frame).toContain("Ctrl-s save");
    } finally {
      await act(async () => compose.renderer.destroy());
    }
  });

  test("finishing annotations has no approval workflow", async () => {
    const setup = await renderAt(120, 30, true, {
      ...initialTuiState,
      mode: "confirm-finish",
    });
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Finish annotation");
      expect(frame).toContain("Enter finish");
      expect(frame.toLocaleLowerCase()).not.toContain("approve");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });

  test("empty annotations do not reserve review space", async () => {
    const setup = await renderAt(120, 30);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).not.toContain("Annotations (0)");
      expect(frame).not.toContain("No annotations");
      expect(frame).toContain("src/new.ts [R]");
      expect(frame).toContain("@@ -1,3 +1,4 @@ function run()");
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  });
});
