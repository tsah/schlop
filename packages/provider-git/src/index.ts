import { lstat } from "node:fs/promises";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import type { DiffSurface, SurfaceProvider } from "@schlop/surface-protocol";

export interface GitDiffOptions {
  args?: string[];
  cwd?: string;
  includeUntracked?: boolean;
  title?: string;
}
async function git(
  cwd: string,
  args: string[],
  allowDiffExit = false,
): Promise<Uint8Array> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_EXTERNAL_DIFF: "",
      GIT_PAGER: "cat",
      PAGER: "cat",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && !(allowDiffExit && code === 1))
    throw new Error(stderr.trim() || `git exited with status ${code}`);
  return stdout;
}
function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "Git output is not valid UTF-8 (consider core.quotepath=false)",
    );
  }
}
function validateArgs(args: string[]): void {
  const forbidden = ["--output", "--ext-diff", "--no-index", "--textconv"];
  for (const arg of args)
    if (forbidden.some((item) => arg === item || arg.startsWith(`${item}=`)))
      throw new Error(`Unsafe or unsupported git diff argument: ${arg}`);
}
export async function repositoryRoot(cwd = process.cwd()): Promise<string> {
  return decode(await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}
async function untrackedPatch(root: string): Promise<string> {
  const output = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = decode(output).split("\0").filter(Boolean);
  const patches: string[] = [];
  for (const path of paths) {
    const stat = await lstat(`${root}/${path}`);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    if (stat.size === 0) {
      patches.push(
        `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/${path}\n`,
      );
      continue;
    }
    const patch = decode(
      await git(
        root,
        [
          "--no-pager",
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--",
          "/dev/null",
          path,
        ],
        true,
      ),
    );
    patches.push(
      patch
        .replaceAll("a/dev/null", "a/" + path)
        .replaceAll(`b/${path}`, "b/" + path),
    );
  }
  return patches.join("\n");
}
export const gitProvider = {
  id: "git",
  async createSurface(options): Promise<DiffSurface> {
    const args = options.args ?? [];
    validateArgs(args);
    const root = await repositoryRoot(options.cwd);
    const tracked = decode(
      await git(root, [
        "--no-pager",
        "-c",
        "core.quotepath=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        ...args,
      ]),
    );
    const includeUntracked = options.includeUntracked ?? args.length === 0;
    const untracked = includeUntracked ? await untrackedPatch(root) : "";
    const scope = { args, includeUntracked, repositoryRoot: root };
    return parseUnifiedDiff([tracked, untracked].filter(Boolean).join("\n"), {
      title:
        options.title ??
        (args.length ? `Git diff ${args.join(" ")}` : "Working tree changes"),
      metadata: { provider: "git", scope },
      snapshotMetadata: { provider: "git", scope: { args, includeUntracked } },
    });
  },
} satisfies SurfaceProvider<GitDiffOptions>;
export async function isGitSurfaceStale(
  surface: DiffSurface,
): Promise<boolean> {
  const scope = surface.metadata.scope as
    | { args?: string[]; includeUntracked?: boolean; repositoryRoot?: string }
    | undefined;
  if (!scope?.repositoryRoot) return false;
  try {
    const fresh = await gitProvider.createSurface({
      args: scope.args,
      includeUntracked: scope.includeUntracked,
      cwd: scope.repositoryRoot,
      title: surface.title,
    });
    return fresh.snapshotId !== surface.snapshotId;
  } catch {
    return true;
  }
}
