import { z } from "zod";
import {
  AnnotationSchema,
  type Annotation,
  type AnnotationSession,
} from "@schlop/annotation-core";
import type {
  DiffSurface,
  TextSurface,
  MarkdownSurface,
} from "@schlop/surface-protocol";

const labels = {
  "change-request": "Change request",
  question: "Question",
  suggestion: "Suggestion",
  note: "Note",
} as const;
function location(session: AnnotationSession, annotation: Annotation): string {
  const target = annotation.target;
  if (target.kind === "surface") return session.surface.title;
  const document = session.surface.documents.find(
    (item) => item.id === target.documentId,
  );
  const name = document?.path ?? document?.title ?? target.documentId;
  if (target.kind === "document") return name;
  if (target.kind === "text-range")
    return `${name}: lines ${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`}`;
  return `${name}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} (${target.side})`;
}
export function exportMarkdown(session: AnnotationSession): string {
  const output = [
    "# Schlop annotations",
    "",
    `Source: \`${session.surface.title.replaceAll("`", "\\`")}\``,
    "",
  ];
  for (const intent of [
    "change-request",
    "question",
    "suggestion",
    "note",
  ] as const) {
    const items = session.annotations.filter((item) => item.intent === intent);
    if (!items.length) continue;
    output.push(
      `## ${intent === "change-request" ? "Change requests" : `${labels[intent]}s`}`,
      "",
    );
    items.forEach((item, index) => {
      output.push(
        `${index + 1}. \`${location(session, item).replaceAll("`", "\\`")}\``,
        `   ${item.body.replaceAll("\n", "\n   ")}`,
        "",
      );
    });
  }
  if (!session.annotations.length) output.push("No annotations.", "");
  return `${output.join("\n").trimEnd()}\n`;
}
export function exportJson(session: AnnotationSession): string {
  return `${JSON.stringify({ schemaVersion: 1, sessionId: session.id, surface: { kind: session.surface.kind, snapshotId: session.surface.snapshotId, title: session.surface.title }, annotations: session.annotations }, null, 2)}\n`;
}
export const AnnotationResultSchema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(["submitted", "cancelled", "error"]),
  sessionId: z.string().optional(),
  surfaceSnapshotId: z.string().optional(),
  annotations: z.array(AnnotationSchema).optional(),
  formattedFeedback: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
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
): AnnotationResult {
  return {
    schemaVersion: 1,
    outcome,
    sessionId: session.id,
    surfaceSnapshotId: session.surface.snapshotId,
    annotations: session.annotations,
    formattedFeedback: exportMarkdown(session),
  };
}
export type ExportableSurface = DiffSurface | TextSurface | MarkdownSurface;
