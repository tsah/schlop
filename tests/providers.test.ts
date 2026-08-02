import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitProvider } from "@schlop/provider-git";
import { fileProvider, isFileSurfaceStale } from "@schlop/provider-file";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function command(cwd: string, args: string[]) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (await child.exited)
    throw new Error(await new Response(child.stderr).text());
}

test("Git provider captures tracked, untracked, cached, and binary changes without writing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "schlop-git-"));
  temporary.push(root);
  await command(root, ["git", "init", "-q"]);
  await command(root, ["git", "config", "user.email", "test@example.com"]);
  await command(root, ["git", "config", "user.name", "Test"]);
  await writeFile(join(root, "tracked.txt"), "one\n");
  await command(root, ["git", "add", "tracked.txt"]);
  await command(root, ["git", "commit", "-qm", "initial"]);
  await writeFile(join(root, "tracked.txt"), "one\ntwo ✓\n");
  await writeFile(join(root, "untracked.txt"), "new\n");
  await writeFile(join(root, "empty.txt"), "");
  await writeFile(join(root, "binary.bin"), new Uint8Array([0, 1, 2, 3]));
  const surface = await gitProvider.createSurface({ cwd: root });
  expect(surface.documents.map((item) => item.newPath).sort()).toEqual([
    "binary.bin",
    "empty.txt",
    "tracked.txt",
    "untracked.txt",
  ]);
  expect(
    surface.documents.find((item) => item.newPath === "binary.bin")?.status,
  ).toBe("binary");
  expect(await Bun.file(join(root, "tracked.txt")).text()).toBe("one\ntwo ✓\n");
  await command(root, ["git", "add", "tracked.txt"]);
  const cached = await gitProvider.createSurface({
    cwd: root,
    args: ["--cached"],
  });
  expect(cached.documents).toHaveLength(1);
  expect(cached.documents[0]!.newPath).toBe("tracked.txt");
});

test("File provider infers markdown and detects staleness", async () => {
  const root = await mkdtemp(join(tmpdir(), "schlop-file-"));
  temporary.push(root);
  const path = join(root, "README.md");
  await writeFile(path, "# One\n");
  const surface = await fileProvider.createSurface({ path });
  expect(surface.kind).toBe("markdown");
  expect(await isFileSurfaceStale(surface)).toBe(false);
  await writeFile(path, "# Two\n");
  expect(await isFileSurfaceStale(surface)).toBe(true);
});

test("Git provider rejects output-writing arguments", async () => {
  await expect(
    gitProvider.createSurface({ args: ["--output=/tmp/nope"] }),
  ).rejects.toThrow("Unsafe");
});
