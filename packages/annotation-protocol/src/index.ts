import { access, lstat, open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { AnnotationResultSchema } from "@schlop/annotation-export";
import {
  validateSession,
  type AnnotationSession,
} from "@schlop/annotation-core";
import { createTextSurface } from "@schlop/surface-text";
import { createMarkdownSurface } from "@schlop/surface-markdown";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import {
  MAX_SURFACE_BYTES,
  fingerprint,
  type AnnotationSurface,
} from "@schlop/surface-protocol";

const SafeMetadata = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
);
export const AnnotationRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1).max(256),
  surface: z.object({
    kind: z.enum(["text", "markdown", "diff"]),
    title: z.string().min(1).max(4096),
    contentPath: z.string().min(1),
    snapshotId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
  source: z
    .object({
      label: z.string().min(1).max(256),
      metadata: SafeMetadata.optional(),
    })
    .strict()
    .optional(),
  resultPath: z.string().min(1),
  options: z
    .object({
      readOnly: z.boolean().optional(),
      metadata: SafeMetadata.optional(),
    })
    .strict()
    .optional(),
});
export type AnnotationRequest = z.infer<typeof AnnotationRequestSchema>;

export async function loadRequest(path: string): Promise<{
  request: AnnotationRequest;
  content: string;
}> {
  const requestPath = resolve(path);
  const raw = await readFile(requestPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Request contains invalid JSON");
  }
  const request = AnnotationRequestSchema.parse(value);
  const contentPath = resolve(request.surface.contentPath);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(contentPath, constants.O_RDONLY | noFollow);
  let bytes: Uint8Array;
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new Error("Request content path must be a regular file");
    if (stat.size > MAX_SURFACE_BYTES)
      throw new Error(`Request content exceeds ${MAX_SURFACE_BYTES} bytes`);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (decoded.includes("\0"))
    throw new Error("Request content contains NUL bytes");
  if (fingerprint(decoded) !== request.surface.snapshotId)
    throw new Error("Request snapshot identity does not match its content");
  const resultPath = resolve(request.resultPath);
  const parent = dirname(resultPath);
  await access(parent, constants.R_OK | constants.W_OK);
  try {
    const resultStat = await lstat(resultPath);
    if (resultStat.isSymbolicLink())
      throw new Error("Request result path must not be a symlink");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { request, content: decoded };
}

export function createRequestSurface(
  loaded: Awaited<ReturnType<typeof loadRequest>>,
): AnnotationSurface {
  const { request, content } = loaded;
  const metadata = {
    provider: "request",
    ...(request.source?.label ? { sourceLabel: request.source.label } : {}),
  };
  const built =
    request.surface.kind === "markdown"
      ? createMarkdownSurface({
          content,
          title: request.surface.title,
          metadata,
        })
      : request.surface.kind === "diff"
        ? parseUnifiedDiff(content, { title: request.surface.title, metadata })
        : createTextSurface({
            content,
            title: request.surface.title,
            metadata,
          });
  return {
    ...built,
    snapshotId: request.surface.snapshotId,
  } as AnnotationSurface;
}

export function validateResult(
  value: unknown,
  expected?: { requestId?: string; session?: AnnotationSession },
) {
  const result = AnnotationResultSchema.parse(value);
  if (expected?.requestId && result.requestId !== expected.requestId)
    throw new Error("Result request id does not match");
  if (expected?.session && result.outcome !== "error") {
    if (result.sessionId !== expected.session.id)
      throw new Error("Result session id does not match");
    if (result.surfaceSnapshotId !== expected.session.surface.snapshotId)
      throw new Error("Result surface snapshot does not match");
    const validation = validateSession({
      ...expected.session,
      annotations: result.annotations ?? [],
    });
    if (!validation.valid)
      throw new Error(
        `Invalid result annotations: ${validation.errors.join("; ")}`,
      );
  }
  return result;
}
