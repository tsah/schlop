import {
  computeSnapshotId,
  fingerprint,
  type MarkdownDocument,
  type MarkdownSurface,
} from "@schlop/surface-protocol";
import { normalizeText } from "@schlop/surface-text";

export interface MarkdownSurfaceOptions {
  content: string;
  title: string;
  path?: string;
  metadata?: Record<string, unknown>;
}
export function createMarkdownSurface(
  options: MarkdownSurfaceOptions,
): MarkdownSurface {
  const content = normalizeText(options.content);
  const identity = options.path ?? options.title;
  const documentId = fingerprint(`markdown-document\0${identity}`);
  const lines = content.split("\n").map((line, index) => ({
    id: fingerprint(`${documentId}\0${index + 1}\0${line}`),
    number: index + 1,
    content: line,
  }));
  const headings = lines.flatMap((line) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.content);
    return match
      ? [
          {
            id: fingerprint(
              `${documentId}\0heading\0${line.number}\0${match[2]}`,
            ),
            line: line.number,
            level: match[1]!.length,
            text: match[2]!,
          },
        ]
      : [];
  });
  const document: MarkdownDocument = {
    id: documentId,
    ...(options.path ? { path: options.path } : {}),
    title: options.title,
    mediaType: "text/markdown",
    contentFingerprint: fingerprint(content),
    metadata: {},
    content,
    lines,
    headings,
  };
  const withoutId = {
    schemaVersion: 1 as const,
    kind: "markdown" as const,
    title: options.title,
    documents: [document],
    metadata: options.metadata ?? {},
  };
  return { ...withoutId, snapshotId: computeSnapshotId(withoutId) };
}
