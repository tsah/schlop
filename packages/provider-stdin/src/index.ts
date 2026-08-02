import {
  MAX_SURFACE_BYTES,
  type AnnotationSurface,
  type SurfaceProvider,
} from "@schlop/surface-protocol";
import { createTextSurface } from "@schlop/surface-text";
import { createMarkdownSurface } from "@schlop/surface-markdown";
import { parseUnifiedDiff } from "@schlop/surface-diff";

export type StdinType = "text" | "markdown" | "diff";
export interface StdinOptions {
  type: StdinType;
  title?: string;
  sourceLabel?: string;
  stream?: ReadableStream<Uint8Array>;
}
export async function readUtf8(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_SURFACE_BYTES,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`Input exceeds ${limit} byte limit`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Input is not valid UTF-8");
  }
}
export const stdinProvider: SurfaceProvider<StdinOptions> = {
  id: "stdin",
  async createSurface(options): Promise<AnnotationSurface> {
    const content = await readUtf8(options.stream ?? Bun.stdin.stream());
    const title = options.title ?? "Standard input";
    const metadata = {
      provider: "stdin",
      ...(options.sourceLabel ? { sourceLabel: options.sourceLabel } : {}),
    };
    if (options.type === "markdown")
      return createMarkdownSurface({ content, title, metadata });
    if (options.type === "diff")
      return parseUnifiedDiff(content, { title, metadata });
    return createTextSurface({ content, title, metadata });
  },
};
