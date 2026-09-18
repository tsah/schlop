import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants, openSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AnnotationSession } from "@schlop/annotation-core";
import { dataDirectory } from "@schlop/annotation-storage";

export const MINIMUM_NVIM = "0.9.0";
export interface NvimInfo {
  path?: string;
  version?: string;
  error?: string;
}
function compareVersion(actual: string, required: string) {
  const a = actual.split(".").map(Number);
  const b = required.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
export function configPath(env = process.env, platform = process.platform) {
  if (env.SCHLOP_CONFIG) return env.SCHLOP_CONFIG;
  if (platform === "win32")
    return join(
      env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "Schlop",
      "config.json",
    );
  return join(
    env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "schlop",
    "config.json",
  );
}
async function configuredNvim(env = process.env): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(configPath(env), "utf8")) as {
      nvim?: unknown;
    };
    return typeof value.nvim === "string" ? value.nvim : undefined;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read Schlop configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export async function resolveNvim(
  explicit?: string,
  env = process.env,
): Promise<NvimInfo> {
  const configured = explicit ? undefined : await configuredNvim(env);
  const selected =
    explicit ??
    configured ??
    env.SCHLOP_NVIM ??
    Bun.which("nvim", { PATH: env.PATH });
  if (!selected) return { error: "missing" };
  const path = resolve(selected);
  try {
    const stat = await lstat(path);
    if (!stat.isFile() && !stat.isSymbolicLink())
      return { path, error: "not executable" };
    await access(path, constants.X_OK);
  } catch {
    return { path, error: "not executable" };
  }
  let output: string;
  try {
    const child = Bun.spawn([path, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return { path, error: "not Neovim" };
  } catch {
    return { path, error: "not Neovim" };
  }
  const match = /^NVIM v(\d+\.\d+\.\d+)/m.exec(output);
  if (!match) return { path, error: "not Neovim" };
  const version = match[1]!;
  if (compareVersion(version, MINIMUM_NVIM) < 0)
    return { path, version, error: "unsupported" };
  return { path, version };
}
async function isRuntime(path: string) {
  try {
    return (
      (await lstat(join(path, "lua", "schlop", "launch.lua"))).isFile() &&
      (await lstat(join(path, "lua", "schlop", "init.lua"))).isFile()
    );
  } catch {
    return false;
  }
}
export async function discoverRuntime(
  env = process.env,
): Promise<string | undefined> {
  const candidates: string[] = [];
  if (env.SCHLOP_RUNTIME) {
    const configured = resolve(env.SCHLOP_RUNTIME);
    return (await isRuntime(configured)) ? configured : undefined;
  }
  const executable = await realpath(process.execPath).catch(
    () => process.execPath,
  );
  candidates.push(
    resolve(dirname(executable), "../share/schlop/nvim"),
    resolve(dirname(executable), "share/schlop/nvim"),
    resolve(dirname(executable), "../nvim"),
    resolve(import.meta.dir, "../../../nvim"),
  );
  for (const candidate of [...new Set(candidates)])
    if (await isRuntime(candidate)) return candidate;
  return undefined;
}
export function nvimDiagnostic(info: NvimInfo) {
  if (info.error === "missing")
    return `Schlop requires Neovim ${MINIMUM_NVIM} or newer.\n\nInstall Neovim and ensure \`nvim\` is available on PATH:\n  https://neovim.io/doc/user/install.html\n\nOr specify an existing installation:\n  schlop --nvim /path/to/nvim <command>\n  SCHLOP_NVIM=/path/to/nvim schlop <command>`;
  if (info.error === "unsupported")
    return `Unsupported Neovim installation.\n  executable: ${info.path}\n  detected version: ${info.version}\n  required version: ${MINIMUM_NVIM}\n  https://neovim.io/doc/user/install.html`;
  return `Configured Neovim is ${info.error ?? "unavailable"}: ${info.path ?? "(not found)"}\nRequired: Neovim ${MINIMUM_NVIM} or newer.\nhttps://neovim.io/doc/user/install.html`;
}
function controllerCommand() {
  return basename(process.execPath).startsWith("bun")
    ? [process.execPath, resolve(import.meta.dir, "index.ts")]
    : [process.execPath];
}
export async function launchNvim(options: {
  nvim: string;
  runtime: string;
  session: AnnotationSession;
  resultPath?: string;
  requestId?: string;
  keepTemporary?: boolean;
}): Promise<number> {
  if (process.platform === "win32")
    throw new Error(
      "Standalone Neovim mode currently requires Linux or macOS; Windows console support is not yet tested",
    );
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r+");
  } catch {
    throw new Error(
      "No controlling terminal is available. Run Schlop from an interactive terminal.",
    );
  }
  let temporary: string | undefined;
  try {
    temporary = await mkdtemp(join(tmpdir(), "schlop-"));
    await chmod(temporary, 0o700);
    const launchPath = join(temporary, "launch.json");
    await writeFile(
      launchPath,
      `${JSON.stringify({ schemaVersion: 1, session: options.session, resultPath: options.resultPath, requestId: options.requestId })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const env = {
      ...process.env,
      SCHLOP_RUNTIME: options.runtime,
      SCHLOP_LAUNCH: launchPath,
      SCHLOP_CONTROLLER_COMMAND: JSON.stringify(controllerCommand()),
      SCHLOP_STANDALONE: "1",
    };
    const child = Bun.spawn(
      [
        options.nvim,
        "--cmd",
        "lua vim.opt.runtimepath:prepend(vim.env.SCHLOP_RUNTIME)",
        "-c",
        'lua require("schlop.launch").start()',
      ],
      { stdin: tty, stdout: tty, stderr: tty, env },
    );
    let terminating = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (signal: NodeJS.Signals) => {
      terminating = true;
      child.kill(signal);
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const interrupt = () => terminate("SIGINT");
    const terminateSignal = () => terminate("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminateSignal);
    try {
      const code = await child.exited;
      return terminating ? 130 : code;
    } finally {
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminateSignal);
    }
  } finally {
    closeSync(tty);
    if (temporary && !options.keepTemporary)
      await rm(temporary, { recursive: true, force: true });
  }
}
export async function doctorReport(explicit?: string) {
  const [nvim, runtime] = await Promise.all([
    resolveNvim(explicit),
    discoverRuntime(),
  ]);
  const storage = join(dataDirectory(), "sessions");
  let storageOkay = true;
  try {
    await mkdir(storage, { recursive: true, mode: 0o700 });
    await access(storage, constants.R_OK | constants.W_OK);
  } catch {
    storageOkay = false;
  }
  let tty = "unavailable";
  if (process.platform !== "win32") {
    try {
      const fd = openSync("/dev/tty", "r+");
      closeSync(fd);
      tty = "available";
    } catch {
      tty = "unavailable";
    }
  }
  const executable = await realpath(process.execPath).catch(
    () => process.execPath,
  );
  const lines = [
    "Schlop",
    `  executable:       ${executable}`,
    `  Lua runtime:      ${runtime ?? "missing"}`,
    `  Neovim:           ${nvim.path ?? "missing"}`,
    `  Neovim version:   ${nvim.version ?? "unavailable"}`,
    `  required version: ${MINIMUM_NVIM}`,
    `  session storage:  ${storage}${storageOkay ? "" : " (unusable)"}`,
    `  controlling TTY:  ${tty}`,
  ];
  return {
    text: `${lines.join("\n")}\n`,
    okay: !nvim.error && !!runtime && storageOkay && tty === "available",
  };
}
