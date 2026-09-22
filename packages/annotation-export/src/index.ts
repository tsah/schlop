import { z } from "zod";
import {
  AnnotationSchema,
  type Annotation,
  type AnnotationSession,
} from "@schlop/annotation-core";
import type {
  DiffDocument,
  DiffSurface,
  TextDocument,
  TextSurface,
  MarkdownSurface,
} from "@schlop/surface-protocol";

function location(session: AnnotationSession, annotation: Annotation): string {
  const target = annotation.target;
  if (target.kind === "surface") return session.surface.title;
  const document = session.surface.documents.find(
    (item) => item.id === target.documentId,
  );
  const name = document?.path ?? document?.title ?? target.documentId;
  if (target.kind === "document") return name;
  if (target.kind === "text-range") {
    const { startLine, endLine, startColumn, endColumn } = target;
    if (startColumn && endColumn)
      return startLine === endLine
        ? `${name}: line ${startLine}, columns ${startColumn}-${endColumn}`
        : `${name}: line ${startLine} column ${startColumn} to line ${endLine} column ${endColumn}`;
    return endLine === startLine
      ? `${name}: line ${startLine}`
      : `${name}: lines ${startLine}-${endLine}`;
  }
  return `${name}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} (${target.side})`;
}
// The annotated text itself, so readers who never saw the surface as numbered
// lines still know exactly what each annotation refers to.
function excerpt(session: AnnotationSession, annotation: Annotation): string[] {
  const target = annotation.target;
  if (target.kind === "surface" || target.kind === "document") return [];
  const document = session.surface.documents.find(
    (item) => item.id === target.documentId,
  );
  if (!document) return [];
  if (target.kind === "diff-range")
    return (document as DiffDocument).hunks
      .filter((hunk) => hunk.id === target.hunkId)
      .flatMap((hunk) => hunk.lines)
      .filter((line) => {
        const number = target.side === "old" ? line.oldLine : line.newLine;
        return (
          number !== undefined &&
          number >= target.startLine &&
          number <= target.endLine &&
          line.kind !== (target.side === "old" ? "addition" : "deletion")
        );
      })
      .map((line) => line.content);
  const lines = (document as TextDocument).lines
    .slice(target.startLine - 1, target.endLine)
    .map((line) => line.content);
  if (target.startColumn && target.endColumn && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1]!.slice(
      0,
      target.endColumn,
    );
    lines[0] = lines[0]!.slice(target.startColumn - 1);
  }
  return lines;
}
export function exportMarkdown(session: AnnotationSession): string {
  const output = ["The user added comments:", ""];
  session.annotations.forEach((item, index) => {
    output.push(
      `## ${index + 1}. \`${location(session, item).replaceAll("`", "\\`")}\``,
      "",
    );
    const quoted = excerpt(session, item);
    if (quoted.length)
      output.push(...quoted.map((line) => (line ? `> ${line}` : ">")), "");
    output.push(item.body.trim(), "");
  });
  if (!session.annotations.length) output.push("No annotations.", "");
  return `${output.join("\n").trimEnd()}\n`;
}
export function exportJson(session: AnnotationSession): string {
  return `${JSON.stringify({ schemaVersion: 1, sessionId: session.id, surface: { kind: session.surface.kind, snapshotId: session.surface.snapshotId, title: session.surface.title }, annotations: session.annotations }, null, 2)}\n`;
}
export const AnnotationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.string().optional(),
    outcome: z.enum(["submitted", "cancelled", "error"]),
    sessionId: z.string().optional(),
    surfaceSnapshotId: z.string().optional(),
    annotations: z.array(AnnotationSchema).optional(),
    formattedFeedback: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .superRefine((result, context) => {
    if (result.outcome === "error") {
      if (!result.error)
        context.addIssue({
          code: "custom",
          message: "Error result requires error details",
        });
      return;
    }
    for (const [field, value] of [
      ["sessionId", result.sessionId],
      ["surfaceSnapshotId", result.surfaceSnapshotId],
      ["annotations", result.annotations],
    ] as const)
      if (value === undefined)
        context.addIssue({
          code: "custom",
          message: `${field} is required for ${result.outcome}`,
        });
    if (
      result.outcome === "submitted" &&
      result.formattedFeedback === undefined
    )
      context.addIssue({
        code: "custom",
        message: "Submitted result requires formatted feedback",
      });
  });
export type AnnotationResult = z.infer<typeof AnnotationResultSchema>;
export const COMPLETION_EXIT_CODES = {
  submitted: 0,
  error: 1,
  cancelled: 20,
} as const;
export function completionExitCode(
  outcome: AnnotationResult["outcome"],
): number {
  return COMPLETION_EXIT_CODES[outcome];
}
export function createResult(
  session: AnnotationSession,
  outcome: "submitted" | "cancelled",
  requestId?: string,
): AnnotationResult {
  return {
    schemaVersion: 1,
    ...(requestId ? { requestId } : {}),
    outcome,
    sessionId: session.id,
    surfaceSnapshotId: session.surface.snapshotId,
    annotations: session.annotations,
    formattedFeedback: exportMarkdown(session),
  };
}
export type ExportableSurface = DiffSurface | TextSurface | MarkdownSurface;
