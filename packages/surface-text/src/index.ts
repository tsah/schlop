import {
  computeSnapshotId,
  fingerprint,
  type TextDocument,
  type TextSurface,
} from "@schlop/surface-protocol";

export interface TextSurfaceOptions {
  content: string;
  title: string;
  path?: string;
  metadata?: Record<string, unknown>;
}
export function normalizeText(content: string): string {
  return content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}
export function createTextSurface(options: TextSurfaceOptions): TextSurface {
  const content = normalizeText(options.content);
  const identity = options.path ?? options.title;
  const documentId = fingerprint(`text-document\0${identity}`);
  const document: TextDocument = {
    id: documentId,
    ...(options.path ? { path: options.path } : {}),
    title: options.title,
    mediaType: "text/plain",
    contentFingerprint: fingerprint(content),
    metadata: {},
    content,
    lines: content.split("\n").map((line, index) => ({
      id: fingerprint(`${documentId}\0${index + 1}\0${line}`),
      number: index + 1,
      content: line,
    })),
  };
  const withoutId = {
    schemaVersion: 1 as const,
    kind: "text" as const,
    title: options.title,
    documents: [document],
    metadata: options.metadata ?? {},
  };
  return { ...withoutId, snapshotId: computeSnapshotId(withoutId) };
}
