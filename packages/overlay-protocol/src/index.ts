import { z } from "zod";
import type { AnnotationSurface } from "@schlop/surface-protocol";

export const GuidedDiffEntrySchema = z.object({
  documentId: z.string().min(1),
  summary: z.string().max(20_000),
  hunkIds: z.array(z.string()).max(10_000).optional(),
});
export const GuidedDiffSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(500),
  overview: z.string().max(20_000),
  entries: z.array(GuidedDiffEntrySchema).max(10_000),
  inspected: z.boolean(),
});
export const GuidedDiffOverlaySchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  kind: z.literal("guided-diff"),
  surfaceSnapshotId: z.string(),
  summary: z.string().max(100_000),
  sections: z.array(GuidedDiffSectionSchema).max(1_000),
});
export type GuidedDiffOverlay = z.infer<typeof GuidedDiffOverlaySchema>;
export function validateGuidedDiffOverlay(
  input: unknown,
  surface: AnnotationSurface,
): GuidedDiffOverlay {
  const overlay = GuidedDiffOverlaySchema.parse(input);
  if (surface.kind !== "diff")
    throw new Error("Guided diff overlays require a diff surface");
  if (overlay.surfaceSnapshotId !== surface.snapshotId)
    throw new Error("Overlay snapshot does not match the surface");
  const documents = new Map(
    surface.documents.map((document) => [document.id, document]),
  );
  for (const section of overlay.sections)
    for (const entry of section.entries) {
      const document = documents.get(entry.documentId);
      if (!document)
        throw new Error(`Unknown overlay document: ${entry.documentId}`);
      const hunks = new Set(document.hunks.map((hunk) => hunk.id));
      for (const id of entry.hunkIds ?? [])
        if (!hunks.has(id)) throw new Error(`Unknown overlay hunk: ${id}`);
    }
  return overlay;
}
