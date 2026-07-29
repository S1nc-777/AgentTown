import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { CoreStore, type EventRecord } from "../../core/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTownClient } from "../../cli/src/client.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths
} from "../../cli/src/paths.js";
import {
  CapturedProcessError,
  capture,
  connectOrTerminateCapturedProcess,
  forceReapCapturedProcessTree,
  formatErrorTree,
  runCapturedCommand,
  waitForCapturedProcessTreeExit,
  type ProcessCapture
} from "../src/process-helpers.js";

const PHASE_TIMEOUT_MS = 15_000;
const CLEANUP_RESERVE_MS = 1_000;
const EMPLOYEE_IDS = [
  "leader",
  "developer-a",
  "developer-b",
  "reviewer"
] as const;
const tsxImport = import.meta.resolve("tsx");
const cliMain = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const coreMain = fileURLToPath(new URL("../../core/src/main.ts", import.meta.url));
const roots: string[] = [];

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

async function waitForCoreExit(
  processCapture: ProcessCapture,
  label: string,
  logsDir: string
): Promise<number> {
  const exit = await waitForCapturedProcessTreeExit({
    processCapture,
    descendantPids: () => knownLiveFakePids(logsDir),
    label,
    totalBudgetMs: PHASE_TIMEOUT_MS
  });
  if (exit.code === null) {
    throw new Error(`${label} exited by ${String(exit.signal)}`);
  }
  return exit.code;
}

async function runCli(
  projectRoot: string,
  args: readonly string[]
): Promise<ProcessCapture> {
  const command = cliCommand(args);
  return runCapturedCommand({
    file: command.file,
    args: command.args,
    options: {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: fakeOnlyEnv()
    },
    label: `CLI ${args.join(" ")}`,
    timeoutMs: PHASE_TIMEOUT_MS
  });
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
  const readyDeadline = deadline - CLEANUP_RESERVE_MS;
  try {
    while (!processCapture.stdout.includes("\"type\":\"core.ready\"")) {
      if (
        processCapture.child.exitCode !== null
        || processCapture.child.signalCode !== null
      ) {
        throw new Error(
          `Core exited before ready (code=${String(processCapture.child.exitCode)}, `
          + `signal=${String(processCapture.child.signalCode)})`
        );
      }
      if (Date.now() >= readyDeadline) {
        throw new Error(`Core readiness timed out after ${PHASE_TIMEOUT_MS}ms`);
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    const client = await connectOrTerminateCapturedProcess({
      processCapture,
      connect: () => AgentTownClient.connect(
        pipeName,
        `e2e-${randomUUID()}`,
        0,
        Math.max(1, deadline - Date.now())
      ),
      label: "Core after readiness",
      timeoutMs: Math.max(1, deadline - Date.now())
    });
    return { ...processCapture, client };
  } catch (error) {
    if (error instanceof CapturedProcessError) throw error;
    let cleanupError: unknown;
    try {
      await forceReapCapturedProcessTree({
        processCapture,
        descendantPids: () => knownLiveFakePids(paths.logsDir),
        label: "Core startup failure",
        deadlineAt: deadline
      });
    } catch (terminationError) {
      cleanupError = terminationError;
    }
    throw new CapturedProcessError(
      [
        "Core startup failed",
        "stdout:",
        processCapture.stdout,
        "stderr:",
        processCapture.stderr
      ].join("\n"),
      processCapture,
      {
        cause: new AggregateError(
          cleanupError === undefined ? [error] : [error, cleanupError],
          "Core startup and cleanup failed"
        )
      }
    );
  }
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

function readDatabaseEvents(databasePath: string): EventRecord[] {
  const store = new CoreStore(databasePath);
  try {
    return store.listEvents(0);
  } finally {
    store.close();
  }
}

function readDatabaseTasks(databasePath: string): TaskRecord[] {
  const store = new CoreStore(databasePath);
  try {
    return store.listTasks("company");
  } finally {
    store.close();
  }
}

interface ProcessDiagnostic {
  type: "adapter.process.started" | "adapter.process.exited";
  employeeId: string;
  pid: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

async function processDiagnostics(
  logsDir: string,
  employeeIds: readonly string[]
): Promise<ProcessDiagnostic[]> {
  const diagnostics: ProcessDiagnostic[] = [];
  for (const employeeId of employeeIds) {
    const log = await readFile(join(logsDir, `${employeeId}.jsonl`), "utf8");
    for (const line of log.split(/\r?\n/u)) {
      const jsonStart = line.indexOf("{");
      if (jsonStart < 0) continue;
      const parsed = JSON.parse(line.slice(jsonStart)) as Partial<ProcessDiagnostic>;
      if (
        parsed.type === "adapter.process.started"
        || parsed.type === "adapter.process.exited"
      ) {
        diagnostics.push(parsed as ProcessDiagnostic);
      }
    }
  }
  return diagnostics;
}

async function knownLiveFakePids(logsDir: string): Promise<number[]> {
  const diagnostics: ProcessDiagnostic[] = [];
  for (const employeeId of EMPLOYEE_IDS) {
    try {
      diagnostics.push(...await processDiagnostics(logsDir, [employeeId]));
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  const exited = new Set(diagnostics
    .filter(({ type }) => type === "adapter.process.exited")
    .map(({ pid }) => pid));
  return [...new Set(diagnostics
    .filter(({ type }) => type === "adapter.process.started")
    .map(({ pid }) => pid))]
    .filter((pid) => !exited.has(pid) && isProcessAlive(pid));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
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
  await runCapturedCommand({
    file: command,
    args: ["init", "--quiet"],
    options: {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    },
    label: "git init",
    timeoutMs: PHASE_TIMEOUT_MS
  });
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
    let failure: unknown;
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
      expect(completed).toEqual([
        expect.objectContaining({
          id: "task-a",
          status: "completed",
          ownerEmployeeId: "developer-a",
          artifacts: ["artifact:task-a"],
          evidence: ["fake:test:pass"]
        }),
        expect.objectContaining({
          id: "task-b",
          status: "completed",
          ownerEmployeeId: "developer-b",
          artifacts: ["artifact:task-b"],
          evidence: ["fake:test:pass"]
        })
      ]);

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
      await expect(waitForCoreExit(
        firstCore,
        "first Core last-client shutdown",
        paths.logsDir
      ))
        .resolves.toBe(0);
      const retainedAfterPause = await stat(paths.databasePath);
      expect(retainedAfterPause.isFile()).toBe(true);
      const pausedEvents = readDatabaseEvents(paths.databasePath);
      expect(pausedEvents.filter(({ type, payload }) =>
        type === "company.checkpointed"
        && payload.reason === "last_client_exited"
        && payload.sessionCount === 4
      )).toHaveLength(1);
      const stoppedEmployees = pausedEvents
        .filter(({ type }) => type === "session.stopped")
        .map(({ actorId }) => actorId);
      expect(stoppedEmployees).toHaveLength(4);
      expect(new Set(stoppedEmployees)).toEqual(new Set([
        "leader",
        "developer-a",
        "developer-b",
        "reviewer"
      ]));
      const firstStopDiagnostics = await processDiagnostics(paths.logsDir, [
        "leader",
        "developer-a",
        "developer-b",
        "reviewer"
      ]);
      const firstStartedPids = firstStopDiagnostics
        .filter(({ type }) => type === "adapter.process.started")
        .map(({ pid }) => pid);
      expect(firstStartedPids).toHaveLength(4);
      expect(firstStopDiagnostics.filter(({ type }) =>
        type === "adapter.process.exited"
      )).toHaveLength(4);
      expect(firstStartedPids.every((pid) => !isProcessAlive(pid))).toBe(true);

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
      expect(await listTasks(secondCore.client)).toEqual([
        expect.objectContaining({
          id: "task-a",
          status: "completed",
          ownerEmployeeId: "developer-a",
          artifacts: ["artifact:task-a"],
          evidence: ["fake:test:pass"]
        }),
        expect.objectContaining({
          id: "task-b",
          status: "completed",
          ownerEmployeeId: "developer-b",
          artifacts: ["artifact:task-b"],
          evidence: ["fake:test:pass"]
        })
      ]);
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
      await expect(waitForCoreExit(
        secondCore,
        "second Core stop",
        paths.logsDir
      )).resolves.toBe(0);
      expect(readDatabaseTasks(paths.databasePath)).toEqual([
        expect.objectContaining({ id: "task-a", status: "completed" }),
        expect.objectContaining({ id: "task-b", status: "completed" })
      ]);
      const allProcessDiagnostics = await processDiagnostics(paths.logsDir, [
        "leader",
        "developer-a",
        "developer-b",
        "reviewer"
      ]);
      const allStartedPids = allProcessDiagnostics
        .filter(({ type }) => type === "adapter.process.started")
        .map(({ pid }) => pid);
      const allExitedPids = new Set(allProcessDiagnostics
        .filter(({ type }) => type === "adapter.process.exited")
        .map(({ pid }) => pid));
      expect(allStartedPids).toHaveLength(8);
      expect(allStartedPids.every((pid) => allExitedPids.has(pid))).toBe(true);
      expect(allStartedPids.every((pid) => !isProcessAlive(pid))).toBe(true);
      await expect(readFile(paths.companyPath, "utf8"))
        .resolves.toContain("parallel-software");
      expect((await stat(paths.databasePath)).isFile()).toBe(true);
      expect((await readdir(projectRoot)).sort()).toEqual([
        ".agenttown",
        ".git"
      ]);
    } catch (error) {
      failure = error;
      try {
        if ((await stat(paths.databasePath)).isFile()) {
          lastEvents = readDatabaseEvents(paths.databasePath);
        }
      } catch (refreshError) {
        failure = new AggregateError(
          [error, refreshError],
          "E2E failed and refreshing persisted diagnostics also failed"
        );
      }
      console.error([
        failure instanceof Error
          ? formatErrorTree(failure)
          : String(failure),
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
    }
    const cleanupErrors: unknown[] = [];
    const cleanupDeadlineAt = Date.now() + PHASE_TIMEOUT_MS;
    const closeResults = await Promise.allSettled(
      [firstCore?.client, secondCore?.client]
        .filter((client): client is AgentTownClient => client !== undefined)
        .map(async (client) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              client.close(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Core client close exceeded cleanup deadline")),
                  Math.max(0, cleanupDeadlineAt - Date.now())
                );
              })
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        })
    );
    cleanupErrors.push(...closeResults
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map(({ reason }) => reason));
    const coreCleanupTargets: Array<{
      label: string;
      processCapture: RunningCore;
    }> = [];
    if (firstCore !== undefined) {
      coreCleanupTargets.push({
        label: "first Core cleanup",
        processCapture: firstCore
      });
    }
    if (secondCore !== undefined) {
      coreCleanupTargets.push({
        label: "second Core cleanup",
        processCapture: secondCore
      });
    }
    const reapResults = await Promise.allSettled(
      coreCleanupTargets.map(({ label, processCapture }) =>
        forceReapCapturedProcessTree({
          processCapture,
          descendantPids: () => knownLiveFakePids(paths.logsDir),
          label,
          deadlineAt: cleanupDeadlineAt
        })
      )
    );
    cleanupErrors.push(...reapResults
      .filter((result): result is PromiseRejectedResult =>
        result.status === "rejected"
      )
      .map(({ reason }) => reason));
    if (failure !== undefined) {
      if (cleanupErrors.length > 0) {
        console.error(formatErrorTree(new AggregateError(
          cleanupErrors,
          "E2E cleanup diagnostics"
        )));
        throw new AggregateError(
          [failure, ...cleanupErrors],
          "E2E failed and process cleanup was incomplete"
        );
      }
      throw failure;
    }
    if (cleanupErrors.length > 0) {
      console.error(formatErrorTree(new AggregateError(
        cleanupErrors,
        "E2E cleanup diagnostics"
      )));
      throw new AggregateError(cleanupErrors, "E2E process cleanup failed");
    }
  }, 90_000);
});
