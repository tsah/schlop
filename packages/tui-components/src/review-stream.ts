import type { Annotation, AnnotationSession } from "@schlop/annotation-core";
import type {
  DiffDocument,
  DiffLine,
  MarkdownDocument,
  TextDocument,
} from "@schlop/surface-protocol";

export type ReviewStreamItemKind =
  "file-header" | "hunk-header" | "line" | "annotation" | "empty";

export interface ReviewStreamItem {
  id: string;
  kind: ReviewStreamItemKind;
  documentIndex?: number;
  documentId?: string;
  rowIndex?: number;
  selectable: boolean;
  text: string;
  status?: DiffDocument["status"];
  additions?: number;
  deletions?: number;
  lineKind?: "text" | DiffLine["kind"];
  marker?: " " | "+" | "-";
  oldLine?: number;
  newLine?: number;
  side?: "old" | "new";
  line?: number;
  hunkId?: string;
  annotationId?: string;
}

function targetMatchesLine(
  annotation: Annotation,
  item: ReviewStreamItem,
): boolean {
  const target = annotation.target;
  if (item.kind !== "line" || item.documentId === undefined) return false;
  if (target.kind === "text-range")
    return (
      target.documentId === item.documentId &&
      item.line !== undefined &&
      item.line >= target.startLine &&
      item.line <= target.endLine
    );
  if (target.kind === "diff-range")
    return (
      target.documentId === item.documentId &&
      target.hunkId === item.hunkId &&
      target.side === item.side &&
      item.line !== undefined &&
      item.line >= target.startLine &&
      item.line <= target.endLine
    );
  return false;
}

function annotationItem(
  annotation: Annotation,
  documentIndex?: number,
): ReviewStreamItem {
  return {
    id: `annotation:${annotation.id}`,
    kind: "annotation",
    ...(documentIndex === undefined ? {} : { documentIndex }),
    selectable: false,
    text: annotation.body,
    annotationId: annotation.id,
  };
}

function appendRangeAnnotations(
  output: ReviewStreamItem[],
  lines: ReviewStreamItem[],
  annotations: Annotation[],
  documentIndex: number,
): void {
  const remaining = new Set(annotations.map((annotation) => annotation.id));
  for (const line of lines) {
    output.push(line);
    for (const annotation of annotations) {
      if (!remaining.has(annotation.id) || !targetMatchesLine(annotation, line))
        continue;
      const hasLaterMatch = lines
        .slice(lines.indexOf(line) + 1)
        .some((later) => targetMatchesLine(annotation, later));
      if (!hasLaterMatch) {
        output.push(annotationItem(annotation, documentIndex));
        remaining.delete(annotation.id);
      }
    }
  }
}

export function reviewItemHeight(item: ReviewStreamItem): number {
  return item.kind === "annotation" ? 2 : 1;
}

export function reviewWindow(
  stream: ReviewStreamItem[],
  cursorIndex: number,
  height: number,
): { start: number; items: ReviewStreamItem[] } {
  if (!stream.length || height <= 0) return { start: 0, items: [] };
  const cursor = Math.max(0, Math.min(cursorIndex, stream.length - 1));
  let start = cursor;
  let end = cursor + 1;
  let used = reviewItemHeight(stream[cursor]!);
  const beforeBudget = Math.floor(height * 0.55);
  let beforeUsed = 0;
  while (start > 0) {
    const nextHeight = reviewItemHeight(stream[start - 1]!);
    if (used + nextHeight > height || beforeUsed + nextHeight > beforeBudget)
      break;
    start--;
    used += nextHeight;
    beforeUsed += nextHeight;
  }
  while (end < stream.length) {
    const nextHeight = reviewItemHeight(stream[end]!);
    if (used + nextHeight > height) break;
    end++;
    used += nextHeight;
  }
  while (start > 0) {
    const nextHeight = reviewItemHeight(stream[start - 1]!);
    if (used + nextHeight > height) break;
    start--;
    used += nextHeight;
  }
  return { start, items: stream.slice(start, end) };
}

export function buildReviewStream(
  session: AnnotationSession,
  contextSide: "old" | "new" = "new",
): ReviewStreamItem[] {
  const output: ReviewStreamItem[] = [];
  for (const annotation of session.annotations)
    if (annotation.target.kind === "surface")
      output.push(annotationItem(annotation));

  session.surface.documents.forEach((document, documentIndex) => {
    const diff =
      session.surface.kind === "diff" ? (document as DiffDocument) : undefined;
    output.push({
      id: `file:${document.id}`,
      kind: "file-header",
      documentIndex,
      documentId: document.id,
      selectable: false,
      text: document.title,
      ...(diff
        ? {
            status: diff.status,
            additions: diff.additions,
            deletions: diff.deletions,
          }
        : {}),
    });
    for (const annotation of session.annotations)
      if (
        annotation.target.kind === "document" &&
        annotation.target.documentId === document.id
      )
        output.push(annotationItem(annotation, documentIndex));

    const rangeAnnotations = session.annotations.filter(
      (annotation) =>
        (annotation.target.kind === "text-range" ||
          annotation.target.kind === "diff-range") &&
        annotation.target.documentId === document.id,
    );

    if (session.surface.kind === "diff") {
      const diffDocument = document as DiffDocument;
      if (!diffDocument.hunks.length) {
        output.push({
          id: `empty:${document.id}`,
          kind: "empty",
          documentIndex,
          documentId: document.id,
          selectable: false,
          text:
            diffDocument.status === "binary"
              ? "Binary file — document annotations only"
              : "Empty file — document annotations only",
        });
        return;
      }
      let rowIndex = 0;
      for (const hunk of diffDocument.hunks) {
        output.push({
          id: `hunk:${hunk.id}`,
          kind: "hunk-header",
          documentIndex,
          documentId: document.id,
          selectable: false,
          text: hunk.header,
          hunkId: hunk.id,
        });
        const lines = hunk.lines.map((line) => {
          const side =
            line.kind === "deletion"
              ? "old"
              : line.kind === "addition"
                ? "new"
                : contextSide;
          const addressedLine = side === "old" ? line.oldLine : line.newLine;
          const item: ReviewStreamItem = {
            id: `line:${line.id}:${side}`,
            kind: "line",
            documentIndex,
            documentId: document.id,
            rowIndex: rowIndex++,
            selectable: true,
            text: line.content,
            lineKind: line.kind,
            marker:
              line.kind === "addition"
                ? "+"
                : line.kind === "deletion"
                  ? "-"
                  : " ",
            ...(line.oldLine === undefined ? {} : { oldLine: line.oldLine }),
            ...(line.newLine === undefined ? {} : { newLine: line.newLine }),
            side,
            ...(addressedLine === undefined ? {} : { line: addressedLine }),
            hunkId: hunk.id,
          };
          return item;
        });
        appendRangeAnnotations(output, lines, rangeAnnotations, documentIndex);
      }
      return;
    }

    const textDocument = document as TextDocument | MarkdownDocument;
    const lines = textDocument.lines.map(
      (line, rowIndex): ReviewStreamItem => ({
        id: `line:${line.id}`,
        kind: "line",
        documentIndex,
        documentId: document.id,
        rowIndex,
        selectable: true,
        text: line.content,
        lineKind: "text",
        marker: " ",
        line: line.number,
        newLine: line.number,
        side: "new",
      }),
    );
    appendRangeAnnotations(output, lines, rangeAnnotations, documentIndex);
  });
  return output;
}
