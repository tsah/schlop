import { lstat, realpath } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  MAX_SURFACE_BYTES,
  type AnnotationSurface,
  type SurfaceProvider,
} from "@schlop/surface-protocol";
import { createTextSurface } from "@schlop/surface-text";
import { createMarkdownSurface } from "@schlop/surface-markdown";

export interface FileOptions {
  path: string;
  type?: "text" | "markdown";
  title?: string;
}
export const fileProvider: SurfaceProvider<FileOptions> = {
  id: "file",
  async createSurface(options): Promise<AnnotationSurface> {
    const path = resolve(options.path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      throw new Error("Refusing to follow a symbolic link");
    if (!stat.isFile()) throw new Error("Path is not a regular file");
    if (stat.size > MAX_SURFACE_BYTES)
      throw new Error(`File exceeds ${MAX_SURFACE_BYTES} byte limit`);
    const bytes = await Bun.file(path).bytes();
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("File is binary or not valid UTF-8");
    }
    if (content.includes("\0"))
      throw new Error("Binary files are not supported");
    const canonical = await realpath(path);
    const title = options.title ?? basename(path);
    const metadata = {
      provider: "file",
      canonicalPath: canonical,
      size: stat.size,
    };
    const type =
      options.type ??
      ([".md", ".markdown", ".mdown"].includes(extname(path).toLowerCase())
        ? "markdown"
        : "text");
    return type === "markdown"
      ? createMarkdownSurface({ content, title, path: canonical, metadata })
      : createTextSurface({ content, title, path: canonical, metadata });
  },
};
export async function isFileSurfaceStale(
  surface: AnnotationSurface,
): Promise<boolean> {
  const path = surface.documents[0]?.path;
  if (!path) return false;
  try {
    const fresh = await fileProvider.createSurface({
      path,
      type: surface.kind === "markdown" ? "markdown" : "text",
      title: surface.title,
    });
    return (
      fresh.documents[0]?.contentFingerprint !==
      surface.documents[0]?.contentFingerprint
    );
  } catch {
    return true;
  }
}
