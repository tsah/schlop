import { createHash } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;
export const MAX_SURFACE_BYTES = 10 * 1024 * 1024;

export function fingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const SurfaceDocumentSchema = z.object({
  id: z.string().min(1),
  path: z.string().optional(),
  title: z.string(),
  mediaType: z.string().min(1),
  contentFingerprint: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
});
export type SurfaceDocument = z.infer<typeof SurfaceDocumentSchema>;

export const TextLineSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  content: z.string(),
});
export type TextLine = z.infer<typeof TextLineSchema>;

export const TextDocumentSchema = SurfaceDocumentSchema.extend({
  content: z.string(),
  lines: z.array(TextLineSchema),
});
export type TextDocument = z.infer<typeof TextDocumentSchema>;

export const MarkdownHeadingSchema = z.object({
  id: z.string(),
  line: z.number().int().positive(),
  level: z.number().int().min(1).max(6),
  text: z.string(),
});
export type MarkdownHeading = z.infer<typeof MarkdownHeadingSchema>;
export const MarkdownDocumentSchema = TextDocumentSchema.extend({
  headings: z.array(MarkdownHeadingSchema),
});
export type MarkdownDocument = z.infer<typeof MarkdownDocumentSchema>;

export const DiffLineSchema = z.object({
  id: z.string(),
  kind: z.enum(["context", "addition", "deletion"]),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  content: z.string(),
  noNewline: z.boolean().optional(),
});
export type DiffLine = z.infer<typeof DiffLineSchema>;
export const DiffHunkSchema = z.object({
  id: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  header: z.string(),
  lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;
export const DiffDocumentSchema = SurfaceDocumentSchema.extend({
  oldPath: z.string().optional(),
  newPath: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "binary"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunkSchema),
});
export type DiffDocument = z.infer<typeof DiffDocumentSchema>;

const SurfaceBase = z.object({
  schemaVersion: z.literal(1),
  kind: z.string(),
  snapshotId: z.string().min(1),
  title: z.string(),
  documents: z.array(SurfaceDocumentSchema),
  metadata: z.record(z.string(), z.unknown()),
});
export const TextSurfaceSchema = SurfaceBase.extend({
  kind: z.literal("text"),
  documents: z.array(TextDocumentSchema),
});
export const MarkdownSurfaceSchema = SurfaceBase.extend({
  kind: z.literal("markdown"),
  documents: z.array(MarkdownDocumentSchema),
});
export const DiffSurfaceSchema = SurfaceBase.extend({
  kind: z.literal("diff"),
  documents: z.array(DiffDocumentSchema),
  base: z.string().optional(),
  head: z.string().optional(),
});
export const AnnotationSurfaceSchema = z.discriminatedUnion("kind", [
  TextSurfaceSchema,
  MarkdownSurfaceSchema,
  DiffSurfaceSchema,
]);
export type TextSurface = z.infer<typeof TextSurfaceSchema>;
export type MarkdownSurface = z.infer<typeof MarkdownSurfaceSchema>;
export type DiffSurface = z.infer<typeof DiffSurfaceSchema>;
export type AnnotationSurface = z.infer<typeof AnnotationSurfaceSchema>;

export interface SurfaceProvider<TOptions = unknown> {
  id: string;
  createSurface(options: TOptions): Promise<AnnotationSurface>;
}

export function computeSnapshotId(input: unknown): string {
  return fingerprint(stableJson(input));
}
