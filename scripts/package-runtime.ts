import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const share = join(root, "dist", "share", "schlop");
await rm(share, { recursive: true, force: true });
await mkdir(share, { recursive: true });
await cp(join(root, "nvim"), join(share, "nvim"), { recursive: true });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  await cp(join(root, file), join(share, file));
