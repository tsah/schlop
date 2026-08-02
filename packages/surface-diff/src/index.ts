import {
  computeSnapshotId,
  fingerprint,
  type DiffDocument,
  type DiffHunk,
  type DiffLine,
  type DiffSurface,
} from "@schlop/surface-protocol";
import { normalizeText } from "@schlop/surface-text";

export interface DiffParseOptions {
  title?: string;
  metadata?: Record<string, unknown>;
  snapshotMetadata?: Record<string, unknown>;
  base?: string;
  head?: string;
}
function unquotePath(value: string): string {
  if (value === "/dev/null") return value;
  const plain = value.replace(/^[ab]\//, "");
  if (!plain.startsWith('"')) return plain;
  try {
    return JSON.parse(plain);
  } catch {
    return plain.slice(1, -1);
  }
}
function headerPath(line: string): string | undefined {
  const value = line.slice(4).split("\t", 1)[0]!;
  return value === "/dev/null" ? undefined : unquotePath(value);
}
function finalizeDocument(
  raw: string[],
  oldHeader?: string,
  newHeader?: string,
): DiffDocument {
  const oldPathLine = raw.find((line) => line.startsWith("--- ")) ?? oldHeader;
  const newPathLine = raw.find((line) => line.startsWith("+++ ")) ?? newHeader;
  let oldPath = oldPathLine?.startsWith("--- ")
    ? headerPath(oldPathLine)
    : oldPathLine;
  let newPath = newPathLine?.startsWith("+++ ")
    ? headerPath(newPathLine)
    : newPathLine;
  const renameFrom = raw
    .find((line) => line.startsWith("rename from "))
    ?.slice(12);
  const renameTo = raw.find((line) => line.startsWith("rename to "))?.slice(10);
  if (renameFrom) oldPath = unquotePath(renameFrom);
  if (renameTo) newPath = unquotePath(renameTo);
  oldPath ??= newPath ?? "unknown";
  newPath ??= oldPath;
  const binary = raw.some(
    (line) => line.startsWith("Binary files ") || line === "GIT binary patch",
  );
  const added =
    raw.some((line) => line.startsWith("new file mode ")) ||
    raw.some((line) => line === "--- /dev/null");
  const deleted =
    raw.some((line) => line.startsWith("deleted file mode ")) ||
    raw.some((line) => line === "+++ /dev/null");
  const renamed = Boolean(
    renameFrom ||
    renameTo ||
    raw.some((line) => line.startsWith("similarity index ")),
  );
  const status = binary
    ? "binary"
    : renamed
      ? "renamed"
      : added
        ? "added"
        : deleted
          ? "deleted"
          : "modified";
  const documentId = fingerprint(`diff-document\0${oldPath}\0${newPath}`);
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of raw) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        id: fingerprint(
          `${documentId}\0hunk\0${oldLine},${oldCount}\0${newLine},${newCount}\0${match[5]}`,
        ),
        oldStart: oldLine,
        oldCount,
        newStart: newLine,
        newCount,
        header: line,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line === "\\ No newline at end of file") {
      const previous = current.lines.at(-1);
      if (previous) previous.noNewline = true;
      continue;
    }
    const prefix = line[0];
    if (prefix !== " " && prefix !== "+" && prefix !== "-") continue;
    const kind: DiffLine["kind"] =
      prefix === "+" ? "addition" : prefix === "-" ? "deletion" : "context";
    const content = line.slice(1);
    const item: DiffLine = { id: "", kind, content };
    if (kind !== "addition") item.oldLine = oldLine++;
    if (kind !== "deletion") item.newLine = newLine++;
    item.id = fingerprint(
      `${current.id}\0${kind}\0${item.oldLine ?? ""}\0${item.newLine ?? ""}\0${content}`,
    );
    current.lines.push(item);
  }
  const additions = hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.kind === "addition").length,
    0,
  );
  const deletions = hunks.reduce(
    (sum, hunk) =>
      sum + hunk.lines.filter((line) => line.kind === "deletion").length,
    0,
  );
  return {
    id: documentId,
    ...(oldPath ? { oldPath } : {}),
    newPath,
    title: newPath,
    mediaType: "text/x-diff",
    contentFingerprint: fingerprint(raw.join("\n")),
    metadata: {
      headers: raw.filter(
        (line) => !line.startsWith("@@") && !/^[ +\\-]/.test(line),
      ),
    },
    status,
    additions,
    deletions,
    hunks,
  };
}
export function parseUnifiedDiff(
  input: string,
  options: DiffParseOptions = {},
): DiffSurface {
  const content = normalizeText(input);
  const lines = content.split("\n");
  const documents: DiffDocument[] = [];
  let raw: string[] = [];
  let oldFromGit: string | undefined;
  let newFromGit: string | undefined;
  const flush = () => {
    if (raw.length)
      documents.push(finalizeDocument(raw, oldFromGit, newFromGit));
    raw = [];
    oldFromGit = undefined;
    newFromGit = undefined;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+)"?)$/.exec(line);
      oldFromGit = match?.[1];
      newFromGit = match?.[2];
      raw.push(line);
    } else if (raw.length || line.startsWith("--- ")) raw.push(line);
  }
  flush();
  if (documents.length === 0 && content.trim() !== "")
    throw new Error("Input is not a supported unified Git diff");
  const withoutId = {
    schemaVersion: 1 as const,
    kind: "diff" as const,
    title: options.title ?? "Diff",
    documents,
    metadata: options.metadata ?? {},
    ...(options.base ? { base: options.base } : {}),
    ...(options.head ? { head: options.head } : {}),
  };
  const snapshotInput = {
    schemaVersion: withoutId.schemaVersion,
    kind: withoutId.kind,
    documents: withoutId.documents,
    metadata: options.snapshotMetadata ?? withoutId.metadata,
    ...(withoutId.base ? { base: withoutId.base } : {}),
    ...(withoutId.head ? { head: withoutId.head } : {}),
  };
  return { ...withoutId, snapshotId: computeSnapshotId(snapshotInput) };
}
