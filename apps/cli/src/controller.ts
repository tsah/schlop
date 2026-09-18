import { createInterface } from "node:readline";
import { readFile, rm } from "node:fs/promises";
import {
  addAnnotation,
  createSession,
  deleteAnnotation,
  markDocumentInspected,
  markDocumentUninspected,
  targetContext,
  updateAnnotation,
  validateSession,
  type AnnotationIntent,
  type AnnotationSession,
  type AnnotationTarget,
} from "@schlop/annotation-core";
import { atomicText, SessionStore } from "@schlop/annotation-storage";
import { createResult } from "@schlop/annotation-export";
import { fileProvider } from "@schlop/provider-file";
import { gitProvider } from "@schlop/provider-git";
import { createTextSurface } from "@schlop/surface-text";
import { createMarkdownSurface } from "@schlop/surface-markdown";
import { parseUnifiedDiff } from "@schlop/surface-diff";
import { createRequestSurface, loadRequest } from "@schlop/annotation-protocol";
import type { AnnotationSurface } from "@schlop/surface-protocol";

export interface ControllerLaunch {
  schemaVersion: 1;
  session?: AnnotationSession;
  input?:
    | { kind: "file"; path: string; type?: "text" | "markdown" }
    | { kind: "diff"; args: string[] }
    | { kind: "request"; path: string }
    | { kind: "resume"; id?: string }
    | {
        kind: "content";
        surfaceKind: "text" | "markdown" | "diff";
        title: string;
        content: string;
        resultPath?: string;
      };
  resultPath?: string;
  requestId?: string;
}
interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

async function writeResult(
  launch: ControllerLaunch,
  session: AnnotationSession,
  outcome: "submitted" | "approved" | "cancelled",
) {
  if (!launch.resultPath) return;
  await atomicText(
    launch.resultPath,
    `${JSON.stringify(createResult(session, outcome, launch.requestId), null, 2)}\n`,
  );
}

export async function runController(path: string): Promise<void> {
  const launch = JSON.parse(await readFile(path, "utf8")) as ControllerLaunch;
  if (launch.schemaVersion !== 1)
    throw new Error("Unsupported controller launch schema");
  let session = launch.session;
  if (!session && launch.input) {
    let surface: AnnotationSurface;
    if (launch.input.kind === "file")
      surface = await fileProvider.createSurface({
        path: launch.input.path,
        ...(launch.input.type ? { type: launch.input.type } : {}),
      });
    else if (launch.input.kind === "diff")
      surface = await gitProvider.createSurface({ args: launch.input.args });
    else if (launch.input.kind === "request") {
      const loaded = await loadRequest(launch.input.path);
      surface = createRequestSurface(loaded);
      launch.resultPath = loaded.request.resultPath;
      launch.requestId = loaded.request.requestId;
    } else if (launch.input.kind === "resume") {
      const stored = launch.input.id
        ? await new SessionStore().load(launch.input.id)
        : await new SessionStore().mostRecent();
      if (!stored) throw new Error("No compatible session found");
      session = stored;
      surface = stored.surface;
    } else {
      const metadata = { provider: "nvim-plugin" };
      surface =
        launch.input.surfaceKind === "markdown"
          ? createMarkdownSurface({
              content: launch.input.content,
              title: launch.input.title,
              metadata,
            })
          : launch.input.surfaceKind === "diff"
            ? parseUnifiedDiff(launch.input.content, {
                title: launch.input.title,
                metadata,
              })
            : createTextSurface({
                content: launch.input.content,
                title: launch.input.title,
                metadata,
              });
      launch.resultPath = launch.input.resultPath;
    }
    if (!session) session = createSession(surface);
  }
  if (!session) throw new Error("Controller launch has no session or input");
  let current: AnnotationSession = session;
  if (launch.resultPath) await rm(launch.resultPath, { force: true });
  const initial = validateSession(current);
  if (!initial.valid)
    throw new Error(`Invalid launch session: ${initial.errors.join("; ")}`);
  const store = new SessionStore();
  const reply = (value: unknown) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  const save = async () => {
    await store.save(current);
    launch.session = current;
  };
  const handle = async ({ id, method, params = {} }: RpcRequest) => {
    try {
      if (method === "getSession") return reply({ id, result: current });
      const now = new Date().toISOString();
      if (method === "addAnnotation") {
        const target = params.target as AnnotationTarget;
        const completeTarget =
          target.kind === "surface" || target.kind === "document"
            ? target
            : {
                ...target,
                contextFingerprint: targetContext(current.surface, target),
              };
        current = addAnnotation(current, {
          schemaVersion: 1,
          id: crypto.randomUUID(),
          target: completeTarget,
          intent: params.intent as AnnotationIntent,
          body: String(params.body ?? ""),
          source: { kind: "human" },
          createdAt: now,
          updatedAt: now,
        });
        await save();
        return reply({ id, result: current });
      }
      if (method === "updateAnnotation") {
        current = updateAnnotation(
          current,
          String(params.id),
          {
            body: String(params.body ?? ""),
            intent: params.intent as AnnotationIntent,
          },
          now,
        );
        await save();
        return reply({ id, result: current });
      }
      if (method === "deleteAnnotation") {
        current = deleteAnnotation(current, String(params.id), now);
        await save();
        return reply({ id, result: current });
      }
      if (method === "setInspected") {
        current = params.inspected
          ? markDocumentInspected(current, String(params.documentId), now)
          : markDocumentUninspected(current, String(params.documentId), now);
        await save();
        return reply({ id, result: current });
      }
      if (["submit", "approve", "cancel"].includes(method)) {
        const validation = validateSession(current);
        if (!validation.valid) throw new Error(validation.errors.join("; "));
        await save();
        const outcome =
          method === "approve"
            ? "approved"
            : method === "cancel"
              ? "cancelled"
              : "submitted";
        await writeResult(launch, current, outcome);
        return reply({ id, result: { outcome } });
      }
      throw new Error(`Unknown controller method: ${method}`);
    } catch (error) {
      reply({
        id,
        error: {
          code: "SCHLOP_CONTROLLER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let value: RpcRequest;
    try {
      value = JSON.parse(line) as RpcRequest;
    } catch {
      reply({
        id: null,
        error: { code: "INVALID_JSON", message: "Invalid JSON request" },
      });
      continue;
    }
    await handle(value);
  }
}
