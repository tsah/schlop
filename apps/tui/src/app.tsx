import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import {
  CliRenderEvents,
  createCliRenderer,
  defaultTextareaKeyBindings,
  type TextareaRenderable,
} from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import {
  addAnnotation,
  deleteAnnotation,
  markDocumentInspected,
  markDocumentUninspected,
  targetContext,
  updateAnnotation,
  type Annotation,
  type AnnotationIntent,
  type AnnotationSession,
  type AnnotationTarget,
} from "@schlop/annotation-core";
import type {
  DiffDocument,
  DiffLine,
  MarkdownDocument,
  TextDocument,
} from "@schlop/surface-protocol";
import {
  actionHints,
  availableActions,
  buildReviewStream,
  darkTheme,
  fitHints,
  initialTuiState,
  isEnterKey,
  layoutForWidth,
  panesForLayout,
  reviewWindow,
  resolveKey,
  selectionBounds,
  tuiReducer,
  type Pane,
  type ReviewStreamItem,
  type TuiCommand,
  type TuiState,
} from "@schlop/tui-components";

export type TuiOutcome = "submitted" | "cancelled";
export interface TuiResult {
  outcome: TuiOutcome;
  session: AnnotationSession;
}
export interface TuiOptions {
  stale?: boolean;
}
export interface AppProps {
  initial: AnnotationSession;
  stale: boolean;
  initialView?: TuiState;
  onSave(session: AnnotationSession): Promise<void>;
  finish(result: TuiResult): void;
}
interface Row {
  key: string;
  label: string;
  header?: string;
  target?: { hunkId?: string; side?: "old" | "new"; line: number };
}
interface NavigatorItem {
  key: string;
  label: string;
  documentIndex: number;
  rowIndex: number;
  heading?: boolean;
}
const intents: AnnotationIntent[] = [
  "change-request",
  "question",
  "suggestion",
  "note",
];
const intentLabel: Record<AnnotationIntent, string> = {
  "change-request": "Change request",
  question: "Question",
  suggestion: "Suggestion",
  note: "Note",
};
const statusSymbol: Record<DiffDocument["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "B",
};
function rowsFor(
  session: AnnotationSession,
  documentIndex: number,
  contextSide: "old" | "new",
): Row[] {
  const document = session.surface.documents[documentIndex];
  if (!document) return [];
  if (session.surface.kind === "text" || session.surface.kind === "markdown")
    return (document as TextDocument).lines.map((line) => ({
      key: line.id,
      label: `${String(line.number).padStart(4)}  ${line.content}`,
      target: { line: line.number },
    }));
  return (document as DiffDocument).hunks.flatMap((hunk) =>
    hunk.lines.map((line: DiffLine, index) => {
      const sign =
        line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
      const side =
        line.kind === "deletion"
          ? "old"
          : line.kind === "addition"
            ? "new"
            : contextSide;
      const number = side === "old" ? line.oldLine! : line.newLine!;
      return {
        key: line.id,
        ...(index === 0 ? { header: hunk.header } : {}),
        label: `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} ${sign} ${line.content}`,
        target: { hunkId: hunk.id, side, line: number },
      };
    }),
  );
}
function navigatorItems(session: AnnotationSession): NavigatorItem[] {
  return session.surface.documents.flatMap((document, documentIndex) => {
    const inspected = session.progress.inspectedDocumentIds.includes(
      document.id,
    );
    const prefix = inspected ? "✓" : " ";
    const diff =
      session.surface.kind === "diff" ? (document as DiffDocument) : undefined;
    const item: NavigatorItem = {
      key: document.id,
      label: `${prefix} ${diff ? `${statusSymbol[diff.status]} ` : ""}${document.title}${diff ? `  +${diff.additions} -${diff.deletions}` : ""}`,
      documentIndex,
      rowIndex: 0,
    };
    if (session.surface.kind !== "markdown") return [item];
    const headings = (document as MarkdownDocument).headings.map((heading) => ({
      key: heading.id,
      label: `${"  ".repeat(heading.level)}${heading.text}`,
      documentIndex,
      rowIndex: heading.line - 1,
      heading: true,
    }));
    return [item, ...headings];
  });
}
function annotationLocation(
  session: AnnotationSession,
  annotation: Annotation,
): string {
  const target = annotation.target;
  if (target.kind === "surface") return "Entire surface";
  const document = session.surface.documents.find(
    (item) => item.id === target.documentId,
  );
  const name = document?.path ?? document?.title ?? "Unknown document";
  if (target.kind === "document") return name;
  if (target.kind === "text-range")
    return `${name}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`}`;
  return `${name}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} ${target.side}`;
}
function annotationMatchesRow(annotation: Annotation, row: Row): boolean {
  if (!row.target) return false;
  const target = annotation.target;
  if (target.kind === "text-range")
    return (
      row.target.line >= target.startLine && row.target.line <= target.endLine
    );
  if (target.kind === "diff-range")
    return (
      row.target.hunkId === target.hunkId &&
      row.target.side === target.side &&
      row.target.line >= target.startLine &&
      row.target.line <= target.endLine
    );
  return false;
}
function useTerminalSize() {
  const renderer = useRenderer();
  const [size, setSize] = useState({
    width: renderer.width,
    height: renderer.height,
  });
  useEffect(() => {
    const resize = (width: number, height: number) =>
      setSize({ width, height });
    renderer.on(CliRenderEvents.RESIZE, resize);
    return () => {
      renderer.off(CliRenderEvents.RESIZE, resize);
    };
  }, [renderer]);
  return size;
}
function paneColor(active: boolean) {
  return active ? darkTheme.focus : darkTheme.border;
}
export function App({ initial, stale, initialView, onSave, finish }: AppProps) {
  const size = useTerminalSize();
  const [view, dispatch] = useReducer(
    tuiReducer,
    initialView ?? initialTuiState,
  );
  const [session, setSession] = useState(initial);
  const [intent, setIntent] = useState<AnnotationIntent>("change-request");
  const [draft, setDraft] = useState("");
  const [targetMode, setTargetMode] = useState<
    "range" | "document" | "surface"
  >("range");
  const [editing, setEditing] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [status, setStatus] = useState(
    stale ? "STALE — frozen snapshot" : "Ready",
  );
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">(
    "saved",
  );
  const [diffSide, setDiffSide] = useState<"old" | "new">("new");
  const [wrap, setWrap] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const [composerKey, setComposerKey] = useState(0);
  const textareaRef = useRef<TextareaRenderable>(null);
  const pendingChordRef = useRef<"[" | "]" | "g" | undefined>(undefined);
  const rows = rowsFor(session, view.documentIndex, diffSide);
  const documents = navigatorItems(session);
  const document = session.surface.documents[view.documentIndex];
  const selected = selectionBounds(view.selection, view.rowIndex);
  const layout = layoutForWidth(size.width);
  const stream = useMemo(
    () =>
      buildReviewStream(session, diffSide).filter(
        (item) => item.documentIndex === view.documentIndex,
      ),
    [session, diffSide, view.documentIndex],
  );
  const currentStreamIndex = Math.max(
    0,
    stream.findIndex(
      (item) =>
        item.kind === "line" &&
        item.documentIndex === view.documentIndex &&
        item.rowIndex === view.rowIndex,
    ),
  );
  const selectedAnnotation = session.annotations[view.annotationIndex];
  const palette = useMemo(() => {
    const browseState = { ...view, mode: "browse" as const };
    const query = commandQuery.toLocaleLowerCase();
    return availableActions(browseState).filter((item) =>
      `${item.keys} ${item.label}`.toLocaleLowerCase().includes(query),
    );
  }, [commandQuery, view]);
  const persist = async (next: AnnotationSession) => {
    setSaveState("saving");
    try {
      await onSave(next);
      setSaveState("saved");
      setStatus(stale ? "Saved frozen snapshot · source is stale" : "Saved");
    } catch (error) {
      setSaveState("error");
      setStatus(
        `SAVE FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  };
  const complete = async (outcome: TuiOutcome) => {
    try {
      if (!(await persist(session))) return;
      finish({ outcome, session });
    } catch {
      dispatch({ type: "set-mode", mode: "browse" });
    }
  };
  const makeTarget = (): AnnotationTarget => {
    if (targetMode === "surface")
      return { kind: "surface", surfaceSnapshotId: session.surface.snapshotId };
    if (!document) throw new Error("No document is selected");
    if (targetMode === "document")
      return {
        kind: "document",
        surfaceSnapshotId: session.surface.snapshotId,
        documentId: document.id,
      };
    const [startIndex, endIndex] = selected;
    const start = rows[startIndex]?.target;
    const end = rows[endIndex]?.target;
    if (!start || !end)
      throw new Error("This document has no addressable lines");
    if (session.surface.kind === "diff") {
      if (start.hunkId !== end.hunkId || start.side !== end.side)
        throw new Error("Diff ranges must stay within one hunk and side");
      const target: AnnotationTarget = {
        kind: "diff-range",
        surfaceSnapshotId: session.surface.snapshotId,
        documentId: document.id,
        hunkId: start.hunkId!,
        side: start.side!,
        startLine: Math.min(start.line, end.line),
        endLine: Math.max(start.line, end.line),
      };
      return {
        ...target,
        contextFingerprint: targetContext(session.surface, target),
      };
    }
    const target: AnnotationTarget = {
      kind: "text-range",
      surfaceSnapshotId: session.surface.snapshotId,
      documentId: document.id,
      startLine: Math.min(start.line, end.line),
      endLine: Math.max(start.line, end.line),
    };
    return {
      ...target,
      contextFingerprint: targetContext(session.surface, target),
    };
  };
  const targetPreview = () => {
    if (targetMode === "surface") return "Entire surface";
    if (targetMode === "document") return document?.title ?? "Document";
    const [start, end] = selected;
    return `${document?.title ?? "Content"}:${rows[start]?.target?.line ?? "?"}${start === end ? "" : `-${rows[end]?.target?.line ?? "?"}`}${session.surface.kind === "diff" ? ` (${rows[start]?.target?.side ?? diffSide})` : ""}`;
  };
  const submitComment = async () => {
    const body = textareaRef.current?.plainText ?? draft;
    try {
      const now = new Date().toISOString();
      let next: AnnotationSession;
      if (editing)
        next = updateAnnotation(session, editing, { body, intent }, now);
      else
        next = addAnnotation(session, {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          target: makeTarget(),
          intent,
          body,
          source: { kind: "human" },
          createdAt: now,
          updatedAt: now,
        });
      setSession(next);
      setDraft("");
      setEditing(undefined);
      dispatch({ type: "set-mode", mode: "browse" });
      dispatch({
        type: "set-annotation",
        index: editing
          ? next.annotations.findIndex((item) => item.id === editing)
          : next.annotations.length - 1,
        annotationCount: next.annotations.length,
      });
      await persist(next);
      setStatus("Annotation saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const begin = (
    mode: "range" | "document" | "surface",
    annotation?: Annotation,
  ) => {
    setTargetMode(mode);
    setEditing(annotation?.id);
    setIntent(annotation?.intent ?? intent);
    setDraft(annotation?.body ?? "");
    setComposerKey((value) => value + 1);
    dispatch({ type: "set-mode", mode: "compose" });
    if (annotation)
      setTimeout(
        () => textareaRef.current?.setSelection(0, annotation.body.length),
        0,
      );
  };
  const jumpToAnnotation = (index: number) => {
    const annotation = session.annotations[index];
    if (!annotation) return;
    dispatch({
      type: "move-annotation",
      delta: index - view.annotationIndex,
      annotationCount: session.annotations.length,
    });
    if (annotation.target.kind === "surface") return;
    const target = annotation.target;
    const documentIndex = session.surface.documents.findIndex(
      (item) => item.id === target.documentId,
    );
    if (documentIndex < 0) return;
    const targetRows = rowsFor(session, documentIndex, diffSide);
    const rowIndex = targetRows.findIndex((row) =>
      annotationMatchesRow(annotation, row),
    );
    dispatch({
      type: "set-document",
      index: documentIndex,
      rowIndex: Math.max(0, rowIndex),
    });
    dispatch({ type: "set-pane", pane: "annotations" });
  };
  const moveHeading = (delta: number) => {
    if (!document) return;
    const headingRows =
      session.surface.kind === "markdown"
        ? (document as MarkdownDocument).headings.map((item) => item.line - 1)
        : session.surface.kind === "diff"
          ? rows.flatMap((row, index) => (row.header ? [index] : []))
          : [];
    const next =
      delta > 0
        ? headingRows.find((line) => line > view.rowIndex)
        : [...headingRows].reverse().find((line) => line < view.rowIndex);
    if (next !== undefined)
      dispatch({ type: "set-row", index: next, rowCount: rows.length });
  };
  const setActiveDocument = (documentIndex: number, rowIndex = 0) => {
    const navigatorIndex = documents.findIndex(
      (item) => item.documentIndex === documentIndex && !item.heading,
    );
    if (navigatorIndex >= 0)
      dispatch({
        type: "set-navigator",
        index: navigatorIndex,
        itemCount: documents.length,
      });
    dispatch({ type: "set-document", index: documentIndex, rowIndex });
  };
  const moveInStream = (delta: number) => {
    const selectable = stream.filter((item) => item.selectable);
    const current = selectable.findIndex(
      (item) =>
        item.documentIndex === view.documentIndex &&
        item.rowIndex === view.rowIndex,
    );
    const target =
      selectable[Math.max(0, Math.min(selectable.length - 1, current + delta))];
    if (
      !target ||
      target.documentIndex === undefined ||
      target.rowIndex === undefined
    )
      return;
    if (view.selection) {
      if (target.documentIndex !== view.documentIndex) {
        setStatus("Selections cannot cross documents");
        return;
      }
      const currentRows = rowsFor(session, view.documentIndex, diffSide);
      const anchor = currentRows[view.selection.anchor]?.target;
      if (
        session.surface.kind === "diff" &&
        (anchor?.hunkId !== target.hunkId || anchor?.side !== target.side)
      ) {
        setStatus("Selections cannot cross diff hunks or sides");
        return;
      }
      dispatch({
        type: "move-row",
        delta: target.rowIndex - view.rowIndex,
        rowCount: currentRows.length,
      });
      return;
    }
    if (target.documentIndex === view.documentIndex)
      dispatch({
        type: "move-row",
        delta: target.rowIndex - view.rowIndex,
        rowCount: rows.length,
      });
    else setActiveDocument(target.documentIndex, target.rowIndex);
  };
  const perform = (action: TuiCommand) => {
    if (action === "move-down" || action === "move-up") {
      const delta = action === "move-down" ? 1 : -1;
      if (view.pane === "documents")
        dispatch({
          type: "move-navigator",
          delta,
          itemCount: documents.length,
        });
      else if (view.pane === "annotations")
        jumpToAnnotation(
          Math.max(
            0,
            Math.min(
              session.annotations.length - 1,
              view.annotationIndex + delta,
            ),
          ),
        );
      else moveInStream(delta);
    } else if (action === "half-page-down" || action === "half-page-up")
      moveInStream(
        (action === "half-page-down" ? 1 : -1) *
          Math.max(1, Math.floor(size.height / 2)),
      );
    else if (action === "top") moveInStream(-stream.length);
    else if (action === "bottom") moveInStream(stream.length);
    else if (action === "next-pane" || action === "previous-pane") {
      if (!session.annotations.length) {
        const targetPane = view.pane === "documents" ? "content" : "documents";
        dispatch({ type: "set-pane", pane: targetPane });
      } else
        dispatch({ type: "next-pane", reverse: action === "previous-pane" });
    } else if (action === "select-range") dispatch({ type: "select" });
    else if (action === "comment-range") begin("range");
    else if (action === "comment-document") begin("document");
    else if (action === "comment-surface") begin("surface");
    else if (action === "cycle-intent")
      setIntent(
        (value) => intents[(intents.indexOf(value) + 1) % intents.length]!,
      );
    else if (action === "old-side") {
      setDiffSide("old");
      setStatus("Context targets old side");
    } else if (action === "new-side") {
      setDiffSide("new");
      setStatus("Context targets new side");
    } else if (action === "toggle-wrap") setWrap((value) => !value);
    else if (action === "toggle-inspected" && document) {
      const inspected = session.progress.inspectedDocumentIds.includes(
        document.id,
      );
      const next = inspected
        ? markDocumentUninspected(
            session,
            document.id,
            new Date().toISOString(),
          )
        : markDocumentInspected(session, document.id, new Date().toISOString());
      setSession(next);
      void persist(next);
    } else if (action === "next-document" || action === "previous-document") {
      const next = Math.max(
        0,
        Math.min(
          session.surface.documents.length - 1,
          view.documentIndex + (action === "next-document" ? 1 : -1),
        ),
      );
      setActiveDocument(next);
    } else if (action === "next-heading" || action === "previous-heading")
      moveHeading(action === "next-heading" ? 1 : -1);
    else if (action === "next-annotation" || action === "previous-annotation")
      jumpToAnnotation(
        Math.max(
          0,
          Math.min(
            session.annotations.length - 1,
            view.annotationIndex + (action === "next-annotation" ? 1 : -1),
          ),
        ),
      );
    else if (action === "edit-annotation" && selectedAnnotation)
      begin(
        selectedAnnotation.target.kind === "surface"
          ? "surface"
          : selectedAnnotation.target.kind === "document"
            ? "document"
            : "range",
        selectedAnnotation,
      );
    else if (action === "delete-annotation" && selectedAnnotation) {
      setPendingDelete(selectedAnnotation.id);
      dispatch({ type: "set-mode", mode: "confirm-delete" });
    } else if (action === "save-session") void persist(session);
    else if (action === "finish")
      dispatch({ type: "set-mode", mode: "confirm-finish" });
    else if (action === "help") dispatch({ type: "set-mode", mode: "help" });
    else if (action === "commands") {
      setCommandQuery("");
      setCommandIndex(0);
      dispatch({ type: "set-mode", mode: "command" });
    } else if (action === "back")
      dispatch({ type: "set-mode", mode: "confirm-exit" });
  };
  useKeyboard((key) => {
    if (view.mode === "compose") {
      if (key.name === "escape") dispatch({ type: "set-mode", mode: "browse" });
      return;
    }
    if (view.mode === "command") {
      if (key.name === "escape") dispatch({ type: "set-mode", mode: "browse" });
      else if (key.name === "down")
        setCommandIndex((value) => Math.min(palette.length - 1, value + 1));
      else if (key.name === "up")
        setCommandIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (view.mode === "help") {
      if (key.name === "escape" || key.name === "?" || key.name === "q")
        dispatch({ type: "set-mode", mode: "browse" });
      return;
    }
    if (view.mode === "confirm-delete") {
      if (key.name === "escape" || key.name === "n")
        dispatch({ type: "set-mode", mode: "browse" });
      else if ((isEnterKey(key.name) || key.name === "y") && pendingDelete) {
        const next = deleteAnnotation(
          session,
          pendingDelete,
          new Date().toISOString(),
        );
        setSession(next);
        setPendingDelete(undefined);
        dispatch({
          type: "move-annotation",
          delta: 0,
          annotationCount: next.annotations.length,
        });
        dispatch({ type: "set-mode", mode: "browse" });
        void persist(next);
      }
      return;
    }
    if (view.mode === "confirm-finish") {
      if (key.name === "escape") dispatch({ type: "set-mode", mode: "browse" });
      else if (isEnterKey(key.name) || key.name === "s")
        void complete("submitted");
      return;
    }
    if (view.mode === "confirm-exit") {
      if (key.name === "escape" || key.name === "n")
        dispatch({ type: "set-mode", mode: "browse" });
      else if (isEnterKey(key.name) || key.name === "q" || key.name === "y")
        finish({ outcome: "cancelled", session });
      return;
    }
    if (view.pane === "documents" && isEnterKey(key.name)) {
      const item = documents[view.navigatorIndex];
      if (item) setActiveDocument(item.documentIndex, item.rowIndex);
      return;
    }
    if (view.pane === "annotations" && isEnterKey(key.name)) {
      jumpToAnnotation(view.annotationIndex);
      return;
    }
    const resolved = resolveKey(
      { ...view, pendingChord: pendingChordRef.current },
      key,
    );
    if (resolved.state.pendingChord !== pendingChordRef.current) {
      pendingChordRef.current = resolved.state.pendingChord;
      dispatch({
        type: "set-pending-chord",
        chord: resolved.state.pendingChord,
      });
    }
    if (resolved.action) perform(resolved.action);
  });
  if (size.width < 60 || size.height < 16)
    return (
      <box
        style={{ border: true, padding: 1, flexDirection: "column" }}
        title="Schlop"
      >
        <text fg="#ffc857">Terminal too small</text>
        <text>Schlop needs at least 60 columns × 16 rows.</text>
        <text>
          Current: {size.width} × {size.height}
        </text>
      </box>
    );
  if (view.mode === "help") {
    const helpActions = (["documents", "content", "annotations"] as Pane[])
      .flatMap((pane) => availableActions({ ...view, pane, mode: "browse" }))
      .filter(
        (item, index, items) =>
          items.findIndex((other) => other.action === item.action) === index,
      );
    return (
      <box
        style={{
          border: true,
          borderColor: "#45d7e8",
          padding: 1,
          flexDirection: "column",
        }}
        title="Help — generated from active keymap · Esc or ? to close"
      >
        <text fg="#8da1ab">
          Focused panes scope edit/delete and movement. Chord prefixes never
          fall through.
        </text>
        {helpActions.slice(0, size.height - 5).map((item) => (
          <text key={item.action} style={{ height: 1 }}>
            <span fg="#45d7e8">{item.keys.padEnd(14)}</span>
            {item.label}
          </text>
        ))}
      </box>
    );
  }
  if (view.mode === "command")
    return (
      <box
        style={{
          border: true,
          borderColor: "#45d7e8",
          padding: 1,
          flexDirection: "column",
        }}
        title="Commands — type to filter, Esc to close"
      >
        <input
          focused
          placeholder="Search actions…"
          value={commandQuery}
          onInput={(value) => {
            setCommandQuery(value);
            setCommandIndex(0);
          }}
          onSubmit={() => {
            const item = palette[commandIndex];
            if (item) {
              dispatch({ type: "set-mode", mode: "browse" });
              perform(item.action);
            }
          }}
        />
        {palette.slice(0, size.height - 6).map((item, index) => (
          <text
            key={`${item.action}-${item.keys}`}
            fg={index === commandIndex ? "cyan" : "white"}
          >
            {index === commandIndex ? "›" : " "} {item.keys.padEnd(12)}{" "}
            {item.label}
          </text>
        ))}
      </box>
    );
  if (view.mode === "confirm-delete")
    return (
      <box
        style={{
          border: true,
          borderColor: "#ff6b6b",
          padding: 2,
          flexDirection: "column",
        }}
        title="Confirm deletion"
      >
        <text fg="#ff6b6b">Delete this annotation?</text>
        <text>
          {selectedAnnotation
            ? `${intentLabel[selectedAnnotation.intent]} · ${annotationLocation(session, selectedAnnotation)}`
            : "Unknown annotation"}
        </text>
        <text>{selectedAnnotation?.body}</text>
        <text>Enter/y delete · Esc/n keep</text>
      </box>
    );
  if (view.mode === "confirm-finish") {
    const changes = session.annotations.filter(
      (item) => item.intent === "change-request",
    ).length;
    return (
      <box
        style={{
          border: true,
          borderColor: stale ? "#ffc857" : "#45d7e8",
          padding: 2,
          flexDirection: "column",
        }}
        title="Finish annotation"
      >
        <text>
          {session.annotations.length} annotations · {changes} change requests ·{" "}
          {session.progress.inspectedDocumentIds.length}/
          {session.surface.documents.length} inspected
        </text>
        {stale && (
          <text fg="#ffc857">
            STALE: source changed; these annotations refer to the frozen
            snapshot.
          </text>
        )}
        <text>Enter finish · Esc return</text>
      </box>
    );
  }
  if (view.mode === "confirm-exit")
    return (
      <box
        style={{
          border: true,
          borderColor: "#ffc857",
          padding: 2,
          flexDirection: "column",
        }}
        title="Leave Schlop?"
      >
        <text>Your session is autosaved. No feedback will be submitted.</text>
        <text>Enter/q/y leave · Esc/n continue</text>
      </box>
    );
  const composerHeight =
    view.mode === "compose"
      ? Math.min(9, Math.max(5, Math.floor(size.height / 3)))
      : 0;
  const contentHeight = Math.max(
    3,
    size.height - 2 - composerHeight - (layout === "narrow" ? 1 : 0),
  );
  const panes = panesForLayout(layout, view.pane, session.annotations.length);
  const navigatorCapacity = Math.max(1, contentHeight - 2);
  const navigatorStart = Math.max(
    0,
    view.navigatorIndex - navigatorCapacity + 1,
  );
  const annotationCapacity = Math.max(1, Math.floor(contentHeight / 2));
  const annotationStart = Math.max(
    0,
    view.annotationIndex - annotationCapacity + 1,
  );
  const visibleStream = reviewWindow(stream, currentStreamIndex, contentHeight);
  const totalAdditions =
    session.surface.kind === "diff"
      ? session.surface.documents.reduce(
          (sum, item) => sum + (item as DiffDocument).additions,
          0,
        )
      : 0;
  const totalDeletions =
    session.surface.kind === "diff"
      ? session.surface.documents.reduce(
          (sum, item) => sum + (item as DiffDocument).deletions,
          0,
        )
      : 0;
  const scopeLeft = ` SCHLOP  ${stale ? "⚠ STALE · " : ""}${session.surface.title}`;
  const scopeRight =
    session.surface.kind === "diff"
      ? `${session.surface.documents.length} ${session.surface.documents.length === 1 ? "file" : "files"}  +${totalAdditions} -${totalDeletions}  ${session.progress.inspectedDocumentIds.length}/${session.surface.documents.length} inspected `
      : `${session.annotations.length} annotations  ${session.progress.inspectedDocumentIds.length}/${session.surface.documents.length} inspected `;
  const scopeGap = Math.max(
    1,
    size.width - scopeLeft.length - scopeRight.length,
  );
  const modeName =
    view.mode === "compose"
      ? "COMPOSE"
      : view.pane === "annotations"
        ? "COMMENTS"
        : view.selection
          ? "VISUAL"
          : "NORMAL";
  const selectionText = view.selection
    ? `${rows[selected[0]]?.target?.side ?? ""}${rows[selected[0]]?.target?.side ? ":" : ""}${rows[selected[0]]?.target?.line ?? "?"}-${rows[selected[1]]?.target?.line ?? "?"}`
    : "";
  const footerPrefix = `${modeName}${selectionText ? ` ${selectionText}` : ""}`;
  const notice =
    saveState === "saving"
      ? "saving…"
      : saveState === "error"
        ? status
        : stale
          ? "frozen snapshot"
          : status === "Ready" ||
              status === "Saved" ||
              status === "Annotation saved"
            ? ""
            : status;
  const footerHints = fitHints(
    actionHints(view),
    Math.max(0, size.width - footerPrefix.length - notice.length - 8),
  );
  const documentPane = (
    <box
      backgroundColor={darkTheme.surface}
      border={["right"]}
      borderColor={paneColor(view.pane === "documents")}
      style={{
        width: layout === "wide" ? 30 : 24,
        height: "100%",
        flexDirection: "column",
      }}
    >
      <text
        style={{ height: 1 }}
        bg={darkTheme.surfaceRaised}
        fg={view.pane === "documents" ? darkTheme.accent : darkTheme.textMuted}
      >
        {session.surface.kind === "markdown"
          ? " Outline"
          : ` Files · ${session.surface.documents.length}`}
      </text>
      {documents
        .slice(navigatorStart, navigatorStart + navigatorCapacity)
        .map((item, offset) => {
          const index = navigatorStart + offset;
          const active = index === view.navigatorIndex;
          return (
            <text
              key={item.key}
              wrapMode="none"
              truncate
              style={{ height: 1, width: "100%" }}
              bg={active ? darkTheme.selectionBackground : darkTheme.surface}
              fg={
                active
                  ? darkTheme.text
                  : item.heading
                    ? darkTheme.textMuted
                    : darkTheme.text
              }
            >
              {active ? "›" : " "} {item.label}
            </text>
          );
        })}
    </box>
  );
  const annotationPane = (
    <box
      backgroundColor={darkTheme.surface}
      border={["right"]}
      borderColor={paneColor(view.pane === "annotations")}
      style={{
        width: layout === "wide" ? 40 : 30,
        height: "100%",
        flexDirection: "column",
      }}
    >
      <text
        style={{ height: 1 }}
        bg={darkTheme.surfaceRaised}
        fg={darkTheme.accent}
      >
        {` Comments · ${session.annotations.length}`}
      </text>
      {session.annotations.length ? (
        session.annotations
          .slice(annotationStart, annotationStart + annotationCapacity)
          .map((item, offset) => {
            const index = annotationStart + offset;
            const active = index === view.annotationIndex;
            return (
              <box
                key={item.id}
                backgroundColor={
                  active ? darkTheme.selectionBackground : darkTheme.surface
                }
                style={{ height: 2, width: "100%", flexDirection: "column" }}
              >
                <text
                  style={{ height: 1, width: "100%" }}
                  fg={darkTheme.intents[item.intent]}
                >
                  {active ? "›" : " "} {intentLabel[item.intent].toUpperCase()}{" "}
                  · {annotationLocation(session, item)}
                </text>
                <text
                  style={{ height: 1 }}
                  wrapMode="none"
                  truncate
                  fg={darkTheme.text}
                >
                  {`  ${item.body.replaceAll("\n", " ↵ ")}`}
                </text>
              </box>
            );
          })
      ) : (
        <text fg={darkTheme.textMuted}> No annotations yet</text>
      )}
    </box>
  );
  const sideWidth =
    layout === "narrow"
      ? 0
      : panes[0] === "annotations"
        ? layout === "wide"
          ? 40
          : 30
        : layout === "wide"
          ? 30
          : 24;
  const renderStreamItem = (item: ReviewStreamItem, offset: number) => {
    const streamIndex = visibleStream.start + offset;
    if (item.kind === "file-header") {
      const statusText = item.status ? ` [${statusSymbol[item.status]}]` : "";
      const stats =
        item.additions === undefined
          ? ""
          : `  +${item.additions} -${item.deletions}`;
      const left = ` ${item.text}${statusText}`;
      const gap = Math.max(
        1,
        size.width - sideWidth - left.length - stats.length - 2,
      );
      return (
        <text
          key={item.id}
          style={{ height: 1, width: "100%" }}
          bg={darkTheme.surfaceRaised}
          fg={darkTheme.text}
          wrapMode="none"
          truncate
        >
          {left}
          {" ".repeat(gap)}
          <span fg={darkTheme.diff.addition.foreground}>{stats}</span>
        </text>
      );
    }
    if (item.kind === "hunk-header")
      return (
        <box
          key={item.id}
          backgroundColor={darkTheme.surfaceRaised}
          style={{ height: 1, width: "100%" }}
        >
          <text
            style={{ height: 1, width: "100%" }}
            bg={darkTheme.surfaceRaised}
            fg={darkTheme.hunkText}
            wrapMode="none"
            truncate
          >
            {` @@ ${item.text.replace(/^@@\s*/, "")}`}
          </text>
        </box>
      );
    if (item.kind === "annotation") {
      const annotation = session.annotations.find(
        (candidate) => candidate.id === item.annotationId,
      );
      const color = item.intent
        ? darkTheme.intents[item.intent]
        : darkTheme.textMuted;
      return (
        <box
          key={item.id}
          backgroundColor={darkTheme.surface}
          border={["left"]}
          borderColor={color}
          style={{
            height: 2,
            width: "98%",
            marginLeft: 2,
            flexDirection: "column",
          }}
        >
          <text style={{ height: 1, width: "100%" }} fg={color}>
            {` ◆ ${item.intent ? intentLabel[item.intent].toUpperCase() : "ANNOTATION"}${annotation ? ` · ${annotationLocation(session, annotation)}` : ""}`}
          </text>
          <text
            style={{ height: 1 }}
            wrapMode="none"
            truncate
            fg={darkTheme.text}
          >
            {`   ${item.text.replaceAll("\n", " ↵ ")}`}
          </text>
        </box>
      );
    }
    if (item.kind === "empty")
      return (
        <text
          key={item.id}
          style={{ height: 1, width: "100%" }}
          fg={darkTheme.textMuted}
        >
          {`   ${item.text}`}
        </text>
      );
    const current = streamIndex === currentStreamIndex;
    const inSelection =
      Boolean(view.selection) &&
      item.documentIndex === view.documentIndex &&
      item.rowIndex !== undefined &&
      item.rowIndex >= selected[0] &&
      item.rowIndex <= selected[1];
    const semantic =
      item.lineKind === "addition"
        ? darkTheme.diff.addition
        : item.lineKind === "deletion"
          ? darkTheme.diff.deletion
          : darkTheme.diff.context;
    const background =
      inSelection || current
        ? darkTheme.selectionBackground
        : semantic.background;
    const marker = item.marker ?? semantic.marker;
    const oldNumber = String(item.oldLine ?? "").padStart(4);
    const newNumber = String(
      item.lineKind === "text" ? (item.line ?? "") : (item.newLine ?? ""),
    ).padStart(4);
    const hasInlineAnnotation = stream[streamIndex + 1]?.kind === "annotation";
    return (
      <box
        key={item.id}
        backgroundColor={background}
        style={{ height: wrap ? 2 : 1, width: "100%" }}
      >
        <text
          style={{ height: wrap ? 2 : 1, width: "100%" }}
          bg={background}
          fg={semantic.foreground}
          wrapMode={wrap ? "word" : "none"}
          truncate={!wrap}
        >
          <span fg={current ? darkTheme.accent : darkTheme.textMuted}>
            {current ? "›" : " "}
            {hasInlineAnnotation ? "◆" : " "}
          </span>
          {` ${oldNumber} ${newNumber} ${marker} ${item.text}`}
        </text>
      </box>
    );
  };
  const contentPane = (
    <box
      backgroundColor={darkTheme.background}
      style={{ height: "100%", flexGrow: 1, flexDirection: "column" }}
    >
      {visibleStream.items.map(renderStreamItem)}
    </box>
  );
  const activePane: Record<Pane, React.ReactNode> = {
    documents: documentPane,
    content: contentPane,
    annotations: annotationPane,
  };
  return (
    <box
      backgroundColor={darkTheme.background}
      style={{ width: "100%", height: "100%", flexDirection: "column" }}
    >
      <text
        style={{ height: 1, width: "100%" }}
        bg={darkTheme.surfaceRaised}
        fg={stale ? darkTheme.warning : darkTheme.text}
        wrapMode="none"
        truncate
      >
        {scopeLeft}
        {" ".repeat(scopeGap)}
        {scopeRight}
      </text>
      {layout === "narrow" && (
        <text
          style={{ height: 1 }}
          bg={darkTheme.surface}
          fg={darkTheme.textMuted}
        >
          <span
            fg={
              view.pane === "documents" ? darkTheme.accent : darkTheme.textMuted
            }
          >
            [Files]
          </span>{" "}
          <span
            fg={
              view.pane === "content" ? darkTheme.accent : darkTheme.textMuted
            }
          >
            [Review]
          </span>{" "}
          <span
            fg={
              view.pane === "annotations"
                ? darkTheme.accent
                : darkTheme.textMuted
            }
          >
            [Comments]
          </span>
        </text>
      )}
      <box style={{ flexGrow: 1, flexDirection: "row" }}>
        {layout === "narrow"
          ? activePane[view.pane]
          : panes.map((pane) => (
              <React.Fragment key={pane}>{activePane[pane]}</React.Fragment>
            ))}
      </box>
      {view.mode === "compose" && (
        <box
          backgroundColor={darkTheme.surface}
          border={["left"]}
          borderColor={darkTheme.intents[intent]}
          style={{ height: composerHeight, flexDirection: "column" }}
        >
          <text style={{ height: 1 }} fg={darkTheme.intents[intent]}>
            {` ${intentLabel[intent].toUpperCase()} · ${targetPreview()}`}
          </text>
          <textarea
            key={composerKey}
            ref={textareaRef}
            initialValue={draft}
            focused
            placeholder="Write annotation… Enter newline · Ctrl-s save · Esc back"
            wrapMode="word"
            backgroundColor={darkTheme.surface}
            focusedBackgroundColor={darkTheme.surface}
            textColor={darkTheme.text}
            focusedTextColor={darkTheme.text}
            keyBindings={[
              ...defaultTextareaKeyBindings,
              { name: "s", ctrl: true, action: "submit" },
            ]}
            onContentChange={() =>
              setDraft(textareaRef.current?.plainText ?? "")
            }
            onSubmit={() => void submitComment()}
          />
        </box>
      )}
      <box
        backgroundColor={darkTheme.surfaceRaised}
        style={{ height: 1, width: "100%" }}
      >
        <text
          style={{ height: 1, width: "100%" }}
          bg={darkTheme.surfaceRaised}
          fg={darkTheme.text}
          wrapMode="none"
          truncate
        >
          <span
            bg={darkTheme.accent}
            fg={darkTheme.background}
          >{` ${footerPrefix.padEnd(10)} `}</span>{" "}
          {view.pendingChord ? `waiting for ${view.pendingChord}… · ` : ""}
          {footerHints}
          {notice ? `  ·  ${notice}` : ""}
        </text>
      </box>
    </box>
  );
}
export async function runTui(
  session: AnnotationSession,
  onSave: (session: AnnotationSession) => Promise<void>,
  options: TuiOptions = {},
): Promise<TuiResult> {
  const needsTty = !process.stdin.isTTY || !process.stdout.isTTY;
  const ttyPath = process.platform === "win32" ? "CON" : "/dev/tty";
  const ttyIn = needsTty ? new ReadStream(openSync(ttyPath, "r")) : undefined;
  const ttyOut = needsTty ? new WriteStream(openSync(ttyPath, "w")) : undefined;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    ...(ttyIn && ttyOut ? { stdin: ttyIn, stdout: ttyOut } : {}),
  });
  return await new Promise<TuiResult>((resolve, reject) => {
    let settled = false;
    let current = session;
    const cleanup = (result?: TuiResult, error?: unknown) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      try {
        renderer.destroy();
      } finally {
        ttyIn?.destroy();
        ttyOut?.end();
        if (error) reject(error);
        else resolve(result!);
      }
    };
    const interrupt = () => cleanup({ outcome: "cancelled", session: current });
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      createRoot(renderer).render(
        <App
          initial={session}
          stale={options.stale ?? false}
          onSave={async (next) => {
            await onSave(next);
            current = next;
          }}
          finish={(result) => cleanup(result)}
        />,
      );
    } catch (error) {
      cleanup(undefined, error);
    }
  });
}
