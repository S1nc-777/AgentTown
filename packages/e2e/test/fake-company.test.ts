import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionProposal,
  RecoveryDecision,
  TaskRecord
} from "../../runtime-contract/src/index.js";
import type { EventRecord } from "../../core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTownClient } from "../../cli/src/client.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths
} from "../../cli/src/paths.js";

const PHASE_TIMEOUT_MS = 15_000;
const tsxImport = import.meta.resolve("tsx");
const cliMain = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const coreMain = fileURLToPath(new URL("../../core/src/main.ts", import.meta.url));
const roots: string[] = [];

interface ProcessCapture {
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

interface RunningCore extends ProcessCapture {
  client: AgentTownClient;
}

function fakeOnlyEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTTOWN_FORBID_REAL_PROBES: "1",
    AGENTTOWN_REAL_CODEX: "0",
    AGENTTOWN_REAL_CLAUDE: "0"
  };
}

function cliCommand(args: readonly string[]): { file: string; args: string[] } {
  return {
    file: process.execPath,
    args: ["--import", tsxImport, cliMain, ...args]
  };
}

function capture(child: ChildProcess): ProcessCapture {
  const result: ProcessCapture = { child, stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    result.stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    result.stderr += chunk;
  });
  return result;
}

async function waitForExit(
  processCapture: ProcessCapture,
  label: string,
  timeoutMs = PHASE_TIMEOUT_MS
): Promise<number> {
  const existing = processCapture.child.exitCode;
  if (existing !== null) return existing;
  return await new Promise<number>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      processCapture.child.off("error", onError);
      processCapture.child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code === null) {
        reject(new Error(`${label} exited by ${String(signal)}`));
      } else {
        resolvePromise(code);
      }
    };
    processCapture.child.once("error", onError);
    processCapture.child.once("exit", onExit);
  });
}

async function runCli(
  projectRoot: string,
  args: readonly string[]
): Promise<ProcessCapture> {
  const command = cliCommand(args);
  const processCapture = capture(spawn(command.file, command.args, {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: fakeOnlyEnv()
  }));
  const code = await waitForExit(processCapture, `CLI ${args[0] ?? "command"}`);
  if (code !== 0) {
    throw new Error(
      `CLI ${args.join(" ")} exited ${code}\n`
      + `stdout:\n${processCapture.stdout}\nstderr:\n${processCapture.stderr}`
    );
  }
  return processCapture;
}

async function startCore(projectRoot: string): Promise<RunningCore> {
  const paths = resolveAgentTownPaths(projectRoot);
  const pipeName = pipeNameForProject(projectRoot);
  const processCapture = capture(spawn(process.execPath, [
    "--import",
    tsxImport,
    coreMain,
    "--project-root",
    projectRoot,
    "--database",
    paths.databasePath,
    "--company",
    paths.companyPath,
    "--pipe-name",
    pipeName,
    "--lease-ttl-ms",
    "300"
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: fakeOnlyEnv()
  }));
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (!processCapture.stdout.includes("\"type\":\"core.ready\"")) {
    if (processCapture.child.exitCode !== null) {
      throw new Error(
        `Core exited before ready (${processCapture.child.exitCode})\n`
        + `stdout:\n${processCapture.stdout}\nstderr:\n${processCapture.stderr}`
      );
    }
    if (Date.now() >= deadline) {
      processCapture.child.kill("SIGKILL");
      throw new Error(
        `Core readiness timed out\nstdout:\n${processCapture.stdout}\n`
        + `stderr:\n${processCapture.stderr}`
      );
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const client = await AgentTownClient.connect(
    pipeName,
    `e2e-${randomUUID()}`,
    0,
    Math.max(1, deadline - Date.now())
  );
  return { ...processCapture, client };
}

function action(input: {
  type: ActionProposal["type"];
  actor: string;
  taskId: string | null;
  payload?: Record<string, unknown>;
}): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: randomUUID(),
    type: input.type,
    actorEmployeeId: input.actor,
    taskId: input.taskId,
    payload: input.payload ?? {},
    reason: `e2e:${input.type}`,
    causationEventId: null
  };
}

async function dispatch(
  client: AgentTownClient,
  proposal: ActionProposal
): Promise<void> {
  await coreRequest(client, "action.dispatch", { action: proposal });
}

async function listTasks(client: AgentTownClient): Promise<TaskRecord[]> {
  return await coreRequest(
    client,
    "tasks.list",
    { companyId: "company" }
  ) as TaskRecord[];
}

async function listEvents(client: AgentTownClient): Promise<EventRecord[]> {
  return await coreRequest(
    client,
    "events.list",
    { afterSequence: 0 }
  ) as EventRecord[];
}

async function coreRequest(
  client: AgentTownClient,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.request(method, params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `Core request ${method} timed out after ${PHASE_TIMEOUT_MS}ms`
          )),
          PHASE_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitUntil(
  description: string,
  predicate: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`${description} timed out after ${PHASE_TIMEOUT_MS}ms`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function initializeTemporaryGitRepository(root: string): Promise<void> {
  const command = process.platform === "win32" ? "git.exe" : "git";
  const processCapture = capture(spawn(command, ["init", "--quiet"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }));
  const code = await waitForExit(processCapture, "git init");
  if (code !== 0) throw new Error(`git init failed: ${processCapture.stderr}`);
}

async function terminateIfRunning(processCapture: ProcessCapture | undefined): Promise<void> {
  if (
    processCapture === undefined
    || processCapture.child.exitCode !== null
    || processCapture.child.signalCode !== null
  ) {
    return;
  }
  processCapture.child.kill("SIGKILL");
  await waitForExit(processCapture, "forced cleanup").catch(() => undefined);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("P1A real Fake Company lifecycle", () => {
  it("preserves a reviewed parallel company across last-client restart", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "agenttown-e2e-"));
    roots.push(projectRoot);
    const paths = resolveAgentTownPaths(projectRoot);
    let firstCore: RunningCore | undefined;
    let secondCore: RunningCore | undefined;
    let lastEvents: EventRecord[] = [];
    try {
      await initializeTemporaryGitRepository(projectRoot);
      await runCli(projectRoot, ["init", "--template", "parallel-software"]);
      firstCore = await startCore(projectRoot);
      await coreRequest(firstCore.client, "company.start", {});

      lastEvents = await listEvents(firstCore.client);
      expect(lastEvents.filter(({ type }) => type === "session.started"))
        .toHaveLength(4);
      expect(new Set(
        lastEvents
          .filter(({ type }) => type === "session.started")
          .map(({ actorId }) => actorId)
      )).toEqual(new Set(["leader", "developer-a", "developer-b", "reviewer"]));

      await expect(dispatch(firstCore.client, action({
        type: "task.approve",
        actor: "developer-a",
        taskId: "not-a-task"
      }))).rejects.toThrow("review permission");
      await expect(dispatch(firstCore.client, action({
        type: "task.propose",
        actor: "employee-5",
        taskId: "invented",
        payload: {
          title: "Invented",
          objective: "Must be rejected",
          dependencies: [],
          acceptanceCriteria: ["never created"]
        }
      }))).rejects.toThrow("unknown employee");

      for (const taskId of ["task-a", "task-b"]) {
        await dispatch(firstCore.client, action({
          type: "task.propose",
          actor: "leader",
          taskId,
          payload: {
            title: `Parallel ${taskId}`,
            objective: `Complete ${taskId}`,
            dependencies: [],
            acceptanceCriteria: [`${taskId} evidence passes`]
          }
        }));
      }
      await Promise.all([
        dispatch(firstCore.client, action({
          type: "task.assign",
          actor: "leader",
          taskId: "task-a",
          payload: { assignee: "developer-a" }
        })),
        dispatch(firstCore.client, action({
          type: "task.assign",
          actor: "leader",
          taskId: "task-b",
          payload: { assignee: "developer-b" }
        }))
      ]);

      await waitUntil("both tasks completed through Fake reviewer", async () =>
        (await listTasks(firstCore!.client))
          .filter(({ status }) => status === "completed").length === 2
      );
      const completed = await listTasks(firstCore.client);
      expect(completed).toHaveLength(2);
      expect(completed.every(({ status }) => status === "completed")).toBe(true);
      expect(completed.every(({ artifacts, evidence }) =>
        artifacts.length > 0 && evidence.length > 0
      )).toBe(true);

      lastEvents = await listEvents(firstCore.client);
      const startedSequences = lastEvents
        .filter(({ type }) => type === "task.started")
        .map(({ sequence }) => sequence);
      const firstSubmission = lastEvents.find(({ type }) => type === "task.submitted");
      expect(startedSequences).toHaveLength(2);
      expect(firstSubmission).toBeDefined();
      expect(Math.max(...startedSequences)).toBeLessThan(firstSubmission!.sequence);
      expect(lastEvents.filter(({ type, actorId }) =>
        type === "task.completed" && actorId === "reviewer"
      )).toHaveLength(2);
      const preRestartSequence = lastEvents.at(-1)!.sequence;

      await firstCore.client.close();
      await expect(waitForExit(firstCore, "first Core last-client shutdown"))
        .resolves.toBe(0);
      const retainedAfterPause = await stat(paths.databasePath);
      expect(retainedAfterPause.isFile()).toBe(true);

      secondCore = await startCore(projectRoot);
      const paused = await coreRequest(secondCore.client, "company.status", {
        companyId: "company"
      }) as { status: string };
      expect(paused.status).toBe("paused");
      const resumed = await coreRequest(secondCore.client, "company.resume", {}) as {
        status: string;
        decisions: RecoveryDecision[];
      };
      expect(resumed.status).toBe("running");
      expect(resumed.decisions).toHaveLength(4);
      expect(resumed.decisions.every(({ mode }) => mode === "native")).toBe(true);
      expect((await listTasks(secondCore.client)).every(
        ({ status }) => status === "completed"
      )).toBe(true);
      lastEvents = await listEvents(secondCore.client);
      expect(lastEvents.at(-1)!.sequence).toBeGreaterThan(preRestartSequence);
      expect(lastEvents.every((event, index) =>
        index === 0 || event.sequence > lastEvents[index - 1]!.sequence
      )).toBe(true);

      const status = await runCli(projectRoot, ["status"]);
      for (const employeeId of ["leader", "developer-a", "developer-b", "reviewer"]) {
        expect(status.stdout).toContain(employeeId);
      }
      expect(status.stdout).toContain("context=unknown");

      await runCli(projectRoot, ["stop", "--yes"]);
      await secondCore.client.close();
      await expect(waitForExit(secondCore, "second Core stop")).resolves.toBe(0);
      await expect(readFile(paths.companyPath, "utf8"))
        .resolves.toContain("parallel-software");
      expect((await stat(paths.databasePath)).isFile()).toBe(true);
      expect((await readdir(projectRoot)).sort()).toEqual([
        ".agenttown",
        ".git"
      ]);
    } catch (error) {
      console.error([
        error instanceof Error ? error.stack ?? error.message : String(error),
        "first Core stdout:",
        firstCore?.stdout ?? "",
        "first Core stderr:",
        firstCore?.stderr ?? "",
        "second Core stdout:",
        secondCore?.stdout ?? "",
        "second Core stderr:",
        secondCore?.stderr ?? "",
        "last 30 events:",
        JSON.stringify(lastEvents.slice(-30), null, 2)
      ].join("\n"));
      throw error;
    } finally {
      await firstCore?.client.close().catch(() => undefined);
      await secondCore?.client.close().catch(() => undefined);
      await terminateIfRunning(firstCore);
      await terminateIfRunning(secondCore);
    }
  }, 90_000);
});
