import { z } from "zod";
import type {
  AnnotationSurface,
  DiffDocument,
  TextDocument,
} from "@schlop/surface-protocol";
import { fingerprint } from "@schlop/surface-protocol";

const TargetIdentity = z.object({
  surfaceSnapshotId: z.string(),
  documentId: z.string(),
  contextFingerprint: z.string().optional(),
});
export const AnnotationTargetSchema = z.discriminatedUnion("kind", [
  TargetIdentity.extend({
    kind: z.literal("text-range"),
    startLine: z.number().int().positive(),
    startColumn: z.number().int().positive().optional(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().positive().optional(),
  }),
  TargetIdentity.extend({
    kind: z.literal("diff-range"),
    hunkId: z.string(),
    side: z.enum(["old", "new"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  TargetIdentity.extend({ kind: z.literal("document") }),
  z.object({ kind: z.literal("surface"), surfaceSnapshotId: z.string() }),
]);
export type AnnotationTarget = z.infer<typeof AnnotationTargetSchema>;
export const AnnotationIntentSchema = z.enum([
  "change-request",
  "question",
  "suggestion",
  "note",
]);
export type AnnotationIntent = z.infer<typeof AnnotationIntentSchema>;
export const AnnotationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }),
  z.object({ kind: z.literal("external"), name: z.string().min(1) }),
]);
export const AnnotationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  target: AnnotationTargetSchema,
  intent: AnnotationIntentSchema,
  body: z.string().trim().min(1),
  source: AnnotationSourceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const AnnotationOverlaySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    kind: z.string().min(1),
    surfaceSnapshotId: z.string().min(1),
  })
  .passthrough();
export type AnnotationOverlay = z.infer<typeof AnnotationOverlaySchema>;
export const AnnotationProgressSchema = z.object({
  inspectedDocumentIds: z.array(z.string()),
});
export type AnnotationProgress = z.infer<typeof AnnotationProgressSchema>;
export const AnnotationSessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  surface: z.unknown(),
  annotations: z.array(AnnotationSchema),
  progress: AnnotationProgressSchema,
  overlays: z.array(AnnotationOverlaySchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export interface AnnotationSession {
  schemaVersion: 1;
  id: string;
  surface: AnnotationSurface;
  annotations: Annotation[];
  progress: AnnotationProgress;
  overlays: AnnotationOverlay[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSession(session: AnnotationSession): ValidationResult {
  const errors: string[] = [];
  const documentIds = new Set(
    session.surface.documents.map((document) => document.id),
  );
  const annotationIds = new Set<string>();
  for (const id of session.progress.inspectedDocumentIds)
    if (!documentIds.has(id))
      errors.push(`Inspected document does not exist: ${id}`);
  for (const overlay of session.overlays)
    if (overlay.surfaceSnapshotId !== session.surface.snapshotId)
      errors.push(`Overlay snapshot does not match: ${overlay.id}`);
  for (const annotation of session.annotations) {
    if (annotationIds.has(annotation.id))
      errors.push(`Duplicate annotation id: ${annotation.id}`);
    annotationIds.add(annotation.id);
    const validation = validateTarget(session.surface, annotation.target);
    errors.push(
      ...validation.errors.map(
        (error) => `Annotation ${annotation.id}: ${error}`,
      ),
    );
  }
  return { valid: errors.length === 0, errors };
}

export function targetContext(
  surface: AnnotationSurface,
  target: AnnotationTarget,
): string | undefined {
  if (target.kind === "surface" || target.kind === "document") return undefined;
  const document = surface.documents.find(
    (item) => item.id === target.documentId,
  );
  if (!document) return undefined;
  if (
    target.kind === "text-range" &&
    (surface.kind === "text" || surface.kind === "markdown")
  ) {
    const lines = (document as TextDocument).lines
      .slice(target.startLine - 1, target.endLine)
      .map((line) => line.content)
      .join("\n");
    return fingerprint(lines);
  }
  if (target.kind === "diff-range" && surface.kind === "diff") {
    const hunk = (document as DiffDocument).hunks.find(
      (item) => item.id === target.hunkId,
    );
    const lines = hunk?.lines
      .filter((line) =>
        target.side === "old"
          ? line.oldLine !== undefined
          : line.newLine !== undefined,
      )
      .filter((line) => {
        const number = target.side === "old" ? line.oldLine : line.newLine;
        return (
          number !== undefined &&
          number >= target.startLine &&
          number <= target.endLine
        );
      })
      .map((line) => line.content)
      .join("\n");
    return lines === undefined ? undefined : fingerprint(lines);
  }
  return undefined;
}

export function validateTarget(
  surface: AnnotationSurface,
  target: AnnotationTarget,
): ValidationResult {
  const parsed = AnnotationTargetSchema.safeParse(target);
  if (!parsed.success)
    return {
      valid: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  const errors: string[] = [];
  if (target.surfaceSnapshotId !== surface.snapshotId)
    errors.push("Target snapshot does not match the surface");
  if (target.kind === "surface") return { valid: errors.length === 0, errors };
  const document = surface.documents.find(
    (item) => item.id === target.documentId,
  );
  if (!document) errors.push("Target document does not exist");
  if (target.kind === "text-range") {
    if (target.startLine > target.endLine)
      errors.push("Range start exceeds range end");
    if (surface.kind !== "text" && surface.kind !== "markdown")
      errors.push("Text target requires a text or markdown surface");
    else if (document) {
      const text = document as TextDocument;
      if (target.endLine > text.lines.length)
        errors.push("Text range exceeds document lines");
      const startLength =
        text.lines[target.startLine - 1]?.content.length ?? -1;
      const endLength = text.lines[target.endLine - 1]?.content.length ?? -1;
      if (target.startColumn && target.startColumn > startLength + 1)
        errors.push("Start column exceeds line length");
      if (target.endColumn && target.endColumn > endLength + 1)
        errors.push("End column exceeds line length");
      if (
        target.startLine === target.endLine &&
        target.startColumn &&
        target.endColumn &&
        target.startColumn > target.endColumn
      )
        errors.push("Column start exceeds column end");
    }
  }
  if (target.kind === "diff-range") {
    if (target.startLine > target.endLine)
      errors.push("Range start exceeds range end");
    if (surface.kind !== "diff")
      errors.push("Diff target requires a diff surface");
    else if (document) {
      const hunk = (document as DiffDocument).hunks.find(
        (item) => item.id === target.hunkId,
      );
      if (!hunk) errors.push("Diff hunk does not exist");
      else {
        const numbers = hunk.lines
          .map((line) => (target.side === "old" ? line.oldLine : line.newLine))
          .filter((value): value is number => value !== undefined);
        if (
          !numbers.some((number) => number === target.startLine) ||
          !numbers.some((number) => number === target.endLine)
        )
          errors.push(`Range is not addressable on the ${target.side} side`);
      }
    }
  }
  if (target.contextFingerprint) {
    const actual = targetContext(surface, target);
    if (!actual || actual !== target.contextFingerprint)
      errors.push("Target context fingerprint does not match");
  }
  return { valid: errors.length === 0, errors };
}

function touch(session: AnnotationSession, now: string): AnnotationSession {
  return { ...session, updatedAt: now };
}
export function addAnnotation(
  session: AnnotationSession,
  annotation: Annotation,
  now = annotation.updatedAt,
): AnnotationSession {
  if (session.annotations.some((item) => item.id === annotation.id))
    throw new Error(`Annotation already exists: ${annotation.id}`);
  const parsed = AnnotationSchema.parse(annotation);
  const validation = validateTarget(session.surface, parsed.target);
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  return touch(
    { ...session, annotations: [...session.annotations, parsed] },
    now,
  );
}
export function updateAnnotation(
  session: AnnotationSession,
  id: string,
  changes: Pick<Annotation, "body" | "intent">,
  now: string,
): AnnotationSession {
  if (!session.annotations.some((item) => item.id === id))
    throw new Error(`Annotation not found: ${id}`);
  return touch(
    {
      ...session,
      annotations: session.annotations.map((item) =>
        item.id === id
          ? AnnotationSchema.parse({ ...item, ...changes, updatedAt: now })
          : item,
      ),
    },
    now,
  );
}
export function deleteAnnotation(
  session: AnnotationSession,
  id: string,
  now: string,
): AnnotationSession {
  if (!session.annotations.some((item) => item.id === id))
    throw new Error(`Annotation not found: ${id}`);
  return touch(
    {
      ...session,
      annotations: session.annotations.filter((item) => item.id !== id),
    },
    now,
  );
}
export function listAnnotations(
  session: AnnotationSession,
  documentId?: string,
): Annotation[] {
  return documentId
    ? session.annotations.filter(
        (item) =>
          "documentId" in item.target && item.target.documentId === documentId,
      )
    : [...session.annotations];
}
export function markDocumentInspected(
  session: AnnotationSession,
  documentId: string,
  now: string,
): AnnotationSession {
  if (!session.surface.documents.some((item) => item.id === documentId))
    throw new Error(`Document not found: ${documentId}`);
  return touch(
    {
      ...session,
      progress: {
        inspectedDocumentIds: [
          ...new Set([...session.progress.inspectedDocumentIds, documentId]),
        ],
      },
    },
    now,
  );
}
export function markDocumentUninspected(
  session: AnnotationSession,
  documentId: string,
  now: string,
): AnnotationSession {
  return touch(
    {
      ...session,
      progress: {
        inspectedDocumentIds: session.progress.inspectedDocumentIds.filter(
          (id) => id !== documentId,
        ),
      },
    },
    now,
  );
}
export function createSession(
  surface: AnnotationSurface,
  options: { id?: string; now?: string } = {},
): AnnotationSession {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    id: options.id ?? crypto.randomUUID(),
    surface,
    annotations: [],
    progress: { inspectedDocumentIds: [] },
    overlays: [],
    createdAt: now,
    updatedAt: now,
  };
}
