import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ActionProposal,
  DeliveryView,
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
  activeAdapterProcessDiagnostics,
  type AdapterProcessDiagnostic,
  CapturedProcessError,
  capture,
  connectOrTerminateCapturedProcess,
  forceReapCapturedProcessTree,
  formatErrorTree,
  parseAdapterProcessDiagnostics,
  runCapturedCommand,
  waitForCapturedProcessTreeExit,
  type ProcessVerification,
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
  priorProcessInstanceIds: ReadonlySet<string>;
  ownedProcessInstanceIds: Set<string>;
}

interface GitProject {
  root: string;
  head(ref: string): Promise<string>;
  changedFiles(commit: string): Promise<string[]>;
}

type P1BStartupScenarios = {
  leader: string;
  "developer-a": string;
  "developer-b": string;
  reviewer: string;
};

function fakeOnlyEnv(
  startupScenarios?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTTOWN_E2E_MODE: "1",
    AGENTTOWN_FORBID_REAL_PROBES: "1",
    AGENTTOWN_REAL_CODEX: "0",
    AGENTTOWN_REAL_CLAUDE: "0",
    AGENTTOWN_E2E_STARTUP_SCENARIOS: startupScenarios === undefined
      ? undefined
      : JSON.stringify(startupScenarios)
  };
}

function cliCommand(args: readonly string[]): { file: string; args: string[] } {
  return {
    file: process.execPath,
    args: ["--import", tsxImport, cliMain, ...args]
  };
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

async function gitIn(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await runCapturedCommand({
    file: "git",
    args: [...args],
    options: {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C"
      }
    },
    label: `git ${args.join(" ")}`,
    timeoutMs: PHASE_TIMEOUT_MS
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.child.exitCode ?? 0
  };
}

async function initializeGitRepository(
  root: string,
  conflict: boolean
): Promise<GitProject> {
  await runCapturedCommand({
    file: "git",
    args: ["init", "-b", "main", "--quiet"],
    options: {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    },
    label: "git init",
    timeoutMs: PHASE_TIMEOUT_MS
  });
  await gitIn(root, ["config", "user.name", "AgentTown E2E"]);
  await gitIn(root, ["config", "user.email", "e2e@example.invalid"]);
  await writeFile(join(root, "README.md"), "initial\n", "utf8");
  await gitIn(root, ["add", "README.md"]);
  await gitIn(root, ["commit", "-m", "initial"]);
  if (conflict) {
    await writeFile(join(root, "shared.txt"), "base\n", "utf8");
    await gitIn(root, ["add", "shared.txt"]);
    await gitIn(root, ["commit", "-m", "shared base"]);
  }
  return {
    root,
    async head(ref) {
      const result = await gitIn(root, ["rev-parse", ref]);
      return result.stdout.trim();
    },
    async changedFiles(commit) {
      const result = await gitIn(root, ["diff", "--name-only", "main", commit]);
      return result.stdout.split(/\r?\n/u).filter((line) => line.length > 0);
    }
  };
}

async function waitForCoreExit(
  processCapture: RunningCore,
  label: string,
  logsDir: string
): Promise<number> {
  const exit = await waitForCapturedProcessTreeExit({
    processCapture,
    verification: () => coreProcessVerification(logsDir, processCapture),
    label,
    totalBudgetMs: PHASE_TIMEOUT_MS
  });
  if (exit.code === null) {
    throw new Error(`${label} exited by ${String(exit.signal)}`);
  }
  return exit.code;
}

async function startCore(
  projectRoot: string,
  startupScenarios: Readonly<Record<string, string>>
): Promise<RunningCore> {
  const paths = resolveAgentTownPaths(projectRoot);
  const pipeName = pipeNameForProject(projectRoot);
  const priorDiagnostics = await processDiagnostics(
    paths.logsDir,
    EMPLOYEE_IDS,
    true
  );
  const priorProcessInstanceIds = new Set(priorDiagnostics.diagnostics
    .map(({ processInstanceId }) => processInstanceId));
  const ownsProcessGroup = process.platform !== "win32";
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
    "5000"
  ], {
    cwd: projectRoot,
    detached: ownsProcessGroup,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: fakeOnlyEnv(startupScenarios)
  }), { ownsProcessGroup });
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
    return {
      ...processCapture,
      client,
      priorProcessInstanceIds,
      ownedProcessInstanceIds: new Set()
    };
  } catch (error) {
    if (error instanceof CapturedProcessError) throw error;
    let cleanupError: unknown;
    try {
      await forceReapCapturedProcessTree({
        processCapture,
        verification: () => processVerification(
          paths.logsDir,
          priorProcessInstanceIds,
          undefined
        ),
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

async function processDiagnostics(
  logsDir: string,
  employeeIds: readonly string[],
  allowMissing = false
): Promise<{
  diagnostics: AdapterProcessDiagnostic[];
  errors: Error[];
}> {
  const diagnostics: AdapterProcessDiagnostic[] = [];
  const errors: Error[] = [];
  for (const employeeId of employeeIds) {
    const path = join(logsDir, `${employeeId}.jsonl`);
    let log: string;
    try {
      log = await readFile(path, "utf8");
    } catch (error) {
      if (
        allowMissing
        && error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    const parsed = parseAdapterProcessDiagnostics(log, path);
    diagnostics.push(...parsed.diagnostics);
    errors.push(...parsed.errors);
  }
  return { diagnostics, errors };
}

async function processVerification(
  logsDir: string,
  excludedInstanceIds: ReadonlySet<string>,
  includedInstanceIds: ReadonlySet<string> | undefined
): Promise<ProcessVerification> {
  const parsed = await processDiagnostics(logsDir, EMPLOYEE_IDS, true);
  const active = activeAdapterProcessDiagnostics(parsed.diagnostics)
    .filter(({ processInstanceId }) =>
      includedInstanceIds === undefined
        ? !excludedInstanceIds.has(processInstanceId)
        : includedInstanceIds.has(processInstanceId)
    );
  return {
    pids: active.map(({ pid }) => pid),
    errors: parsed.errors
  };
}

async function coreProcessVerification(
  logsDir: string,
  core: RunningCore
): Promise<ProcessVerification> {
  return processVerification(
    logsDir,
    core.priorProcessInstanceIds,
    core.ownedProcessInstanceIds.size > 0
      ? core.ownedProcessInstanceIds
      : undefined
  );
}

async function recordCoreProcessInstances(
  logsDir: string,
  core: RunningCore
): Promise<void> {
  const parsed = await processDiagnostics(logsDir, EMPLOYEE_IDS);
  if (parsed.errors.length > 0) {
    throw new AggregateError(
      parsed.errors,
      "Malformed process diagnostics while recording Core ownership"
    );
  }
  for (const diagnostic of parsed.diagnostics) {
    if (!core.priorProcessInstanceIds.has(diagnostic.processInstanceId)) {
      core.ownedProcessInstanceIds.add(diagnostic.processInstanceId);
    }
  }
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

class P1BCompany {
  readonly #cores: RunningCore[] = [];
  readonly #paths: ReturnType<typeof resolveAgentTownPaths>;
  readonly #scenarios: P1BStartupScenarios;

  constructor(
    readonly projectRoot: string,
    public core: RunningCore,
    scenarios: P1BStartupScenarios
  ) {
    this.#paths = resolveAgentTownPaths(projectRoot);
    this.#scenarios = scenarios;
    this.#cores.push(core);
  }

  get client(): AgentTownClient {
    return this.core.client;
  }

  async createParallelTasks(): Promise<void> {
    for (const [taskId, assignee] of [
      ["task-a", "developer-a"],
      ["task-b", "developer-b"]
    ] as const) {
      await dispatch(this.client, action({
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
      await dispatch(this.client, action({
        type: "task.assign",
        actor: "leader",
        taskId,
        payload: { assignee }
      }));
    }
  }

  async waitForBothRunning(): Promise<void> {
    await waitUntil("both tasks entered running", async () =>
      (await listTasks(this.client))
        .filter(({ status }) => status === "running").length === 2
    );
  }

  /**
   * Waits until the given tasks have submitted (left `running`). Submissions
   * durably advance the task workspace records, so a subsequent pause
   * checkpoint always matches the real Git state: no task workspace can be
   * committed-but-unrecorded when the pause snapshot runs.
   */
  async waitForBothSubmissions(taskIds: readonly string[] = ["task-a", "task-b"]): Promise<void> {
    await waitUntil(`tasks submitted: ${taskIds.join(", ")}`, async () => {
      const tasks = await listTasks(this.client);
      const statuses = taskIds
        .map((taskId) => tasks.find(({ id }) => id === taskId))
        .filter((task): task is TaskRecord => task !== undefined)
        .map(({ status }) => status);
      return statuses.length === taskIds.length
        && statuses.every((status) => status !== "running");
    });
  }

  async closeLastClientAndWaitForPause(): Promise<void> {
    const firstCore = this.core;
    await firstCore.client.close();
    const code = await waitForCoreExit(
      firstCore,
      "first Core last-client shutdown",
      this.#paths.logsDir
    );
    expect(code).toBe(0);
    const pausedEvents = readDatabaseEvents(this.#paths.databasePath);
    expect(pausedEvents.filter(({ type, payload }) =>
      type === "company.checkpointed"
      && payload.reason === "last_client_exited"
    )).toHaveLength(1);
  }

  async restart(): Promise<P1BCompany> {
    const recovered = await startCore(this.projectRoot, this.#scenarios);
    this.core = recovered;
    this.#cores.push(recovered);
    const paused = await coreRequest(recovered.client, "company.status", {
      companyId: "company"
    }) as { status: string };
    expect(paused.status).toBe("paused");
    const resumed = await coreRequest(recovered.client, "company.resume", {}) as {
      status: string;
      decisions: RecoveryDecision[];
    };
    expect(resumed.status).toBe("running");
    await recordCoreProcessInstances(this.#paths.logsDir, recovered);
    return this;
  }

  async waitForCompletedTasks(taskIds: readonly string[]): Promise<void> {
    await waitUntil(`tasks completed: ${taskIds.join(", ")}`, async () => {
      const tasks = await listTasks(this.client);
      return taskIds.every((taskId) =>
        tasks.some((task) => task.id === taskId && task.status === "completed")
      );
    });
  }

  async delivery(): Promise<DeliveryView> {
    return await coreRequest(this.client, "git.delivery.get", {}) as DeliveryView;
  }

  async deliveryPreview(): Promise<DeliveryView & { integrationTaskIds: string[] }> {
    const delivery = await this.delivery();
    return {
      ...delivery,
      integrationTaskIds: delivery.tasks.map(({ taskId }) => taskId)
    };
  }

  async timeline(): Promise<EventRecord[]> {
    const result: EventRecord[] = [];
    let afterSequence = 0;
    while (true) {
      const page = await coreRequest(this.client, "events.list", {
        afterSequence,
        limit: 32
      }) as EventRecord[];
      result.push(...page);
      if (page.length < 32) break;
      afterSequence = page.at(-1)!.sequence;
    }
    return result;
  }

  async waitForConflictTask(): Promise<TaskRecord> {
    let found: TaskRecord | undefined;
    await waitUntil("conflict task appeared", async () => {
      const tasks = await listTasks(this.client);
      found = tasks.find(({ id }) => id.startsWith("conflict-"));
      return found !== undefined;
    });
    return found!;
  }

  async assignConflictTask(employeeId: string): Promise<void> {
    const conflictTask = await this.waitForConflictTask();
    await dispatch(this.client, action({
      type: "task.assign",
      actor: "leader",
      taskId: conflictTask.id,
      payload: { assignee: employeeId }
    }));
  }

  async assertNoLiveProcesses(): Promise<void> {
    const parsed = await processDiagnostics(this.#paths.logsDir, EMPLOYEE_IDS);
    expect(parsed.errors).toEqual([]);
    const diagnostics = parsed.diagnostics;
    const startedPids = diagnostics
      .filter(({ type }) => type === "adapter.process.started")
      .map(({ pid }) => pid);
    const startedInstances = diagnostics
      .filter(({ type }) => type === "adapter.process.started")
      .map(({ processInstanceId }) => processInstanceId);
    const exitedInstances = new Set(diagnostics
      .filter(({ type }) => type === "adapter.process.exited")
      .map(({ processInstanceId }) => processInstanceId));
    expect(startedInstances.every((processInstanceId) =>
      exitedInstances.has(processInstanceId)
    )).toBe(true);
    expect(startedPids.every((pid) => !isProcessAlive(pid))).toBe(true);
  }

  async dispose(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    const deadlineAt = Date.now() + PHASE_TIMEOUT_MS;
    for (const core of [...this.#cores].reverse()) {
      try {
        await core.client.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await waitForCapturedProcessTreeExit({
          processCapture: core,
          verification: () => coreProcessVerification(
            this.#paths.logsDir,
            core
          ),
          label: "P1B Core dispose",
          totalBudgetMs: PHASE_TIMEOUT_MS
        });
      } catch (error) {
        try {
          await forceReapCapturedProcessTree({
            processCapture: core,
            verification: () => coreProcessVerification(
              this.#paths.logsDir,
              core
            ),
            label: "P1B Core cleanup",
            deadlineAt
          });
        } catch (reapError) {
          cleanupErrors.push(reapError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "P1B E2E cleanup failed");
    }
  }
}

async function initializeCompany(
  root: string,
  scenarios: P1BStartupScenarios
): Promise<P1BCompany> {
  await runCli(root, ["init", "--template", "parallel-software"]);
  const core = await startCore(root, scenarios);
  const company = new P1BCompany(root, core, scenarios);
  await coreRequest(core.client, "company.start", {});
  await recordCoreProcessInstances(
    resolveAgentTownPaths(root).logsDir,
    core
  );
  return company;
}

async function startP1BCompany(root: string): Promise<P1BCompany> {
  return initializeCompany(root, {
    leader: "idle",
    "developer-a": "git-developer-a",
    "developer-b": "git-developer-b",
    reviewer: "git-review-approve"
  });
}

async function startConflictCompany(root: string): Promise<P1BCompany> {
  const company = await initializeCompany(root, {
    leader: "idle",
    "developer-a": "git-conflict",
    "developer-b": "git-conflict-resolve",
    reviewer: "git-review-approve"
  });
  // The first task (developer-b, git-conflict-resolve) integrates "resolved\n".
  // The second task (developer-a, git-conflict) edits the same shared line to a
  // different deterministic content, so its cherry-pick onto the advanced
  // integration ref conflicts. The resolution reuses developer-a's scenario:
  // the resolution commit's content differs from the integrated first task, so
  // the resolution commit is non-empty and integrates cleanly onto the
  // unchanged formal ref. The fixed review delay guarantees both submissions
  // are validated (base == current integration commit) before the first
  // approval can start integration.
  await dispatch(company.client, action({
    type: "task.propose",
    actor: "leader",
    taskId: "first-task",
    payload: {
      title: "First task",
      objective: "Complete first-task",
      dependencies: [],
      acceptanceCriteria: ["first-task evidence passes"]
    }
  }));
  await dispatch(company.client, action({
    type: "task.assign",
    actor: "leader",
    taskId: "first-task",
    payload: { assignee: "developer-b" }
  }));
  await dispatch(company.client, action({
    type: "task.propose",
    actor: "leader",
    taskId: "second-task",
    payload: {
      title: "Second task",
      objective: "Complete second-task",
      dependencies: [],
      acceptanceCriteria: ["second-task evidence passes"]
    }
  }));
  await dispatch(company.client, action({
    type: "task.assign",
    actor: "leader",
    taskId: "second-task",
    payload: { assignee: "developer-a" }
  }));
  await company.waitForBothSubmissions(["first-task", "second-task"]);
  return company;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("P1B deterministic Git company lifecycle", () => {
  it(
    "runs two isolated Git developers through restart, review and delivery",
    async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "agenttown-p1b-"));
      roots.push(projectRoot);
      const project = await initializeGitRepository(projectRoot, false);
      const original = await project.head("main");
      let company: P1BCompany | undefined;
      let failure: unknown;
      try {
        company = await startP1BCompany(projectRoot);
        await company.createParallelTasks();
        await company.waitForBothRunning();
        await company.waitForBothSubmissions();
        await company.closeLastClientAndWaitForPause();

        const recovered = await company.restart();
        await recovered.waitForCompletedTasks(["task-a", "task-b"]);
        const delivery = await recovered.delivery();

        expect(await project.head("main")).toBe(original);
        expect(delivery.integrationCommit).not.toBe(original);
        expect(await project.changedFiles(delivery.integrationCommit))
          .toEqual(["feature-a.txt", "feature-b.txt"]);
        expect(delivery.tasks.map(({ taskId }) => taskId).sort())
          .toEqual(["task-a", "task-b"]);
        expect(delivery.pushed).toBe(false);
        expect(delivery.mergedIntoUserBranch).toBe(false);
        await runCli(projectRoot, ["stop", "--yes"]);
        await recovered.assertNoLiveProcesses();
      } catch (error) {
        failure = error;
        let lastEvents: EventRecord[] = [];
        try {
          lastEvents = readDatabaseEvents(
            resolveAgentTownPaths(projectRoot).databasePath
          );
        } catch (refreshError) {
          failure = new AggregateError(
            [error, refreshError],
            "E2E failed and refreshing persisted events also failed"
          );
        }
        console.error([
          failure instanceof Error
            ? formatErrorTree(failure)
            : String(failure),
          "Core stdout:",
          company?.core.stdout ?? "",
          "Core stderr:",
          company?.core.stderr ?? "",
          "last 40 events:",
          JSON.stringify(lastEvents.slice(-40), null, 2)
        ].join("\n"));
      }
      if (company !== undefined) {
        await company.dispose().catch((error: unknown) => {
          if (failure === undefined) failure = error;
        });
      }
      if (failure !== undefined) throw failure;
    },
    90_000
  );

  it(
    "turns a deterministic cherry-pick conflict into a reviewed resolution task",
    async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), "agenttown-p1b-conflict-"));
      roots.push(projectRoot);
      await initializeGitRepository(projectRoot, true);
      let company: P1BCompany | undefined;
      let failure: unknown;
      try {
        company = await startConflictCompany(projectRoot);
        await company.waitForConflictTask();
        expect((await company.deliveryPreview()).integrationTaskIds)
          .toEqual(["first-task"]);

        await company.assignConflictTask("developer-a");
        await company.waitForCompletedTasks([
          "first-task",
          "second-task",
          "conflict-second-task-1"
        ]);
        const timeline = await company.timeline();
        expect(timeline.map(({ type }) => type)).toContain(
          "git.integration.conflicted"
        );
        const delivery = await company.delivery();
        expect(delivery.tasks.map(({ taskId }) => taskId).sort())
          .toEqual(["conflict-second-task-1", "first-task"]);
        await runCli(projectRoot, ["stop", "--yes"]);
        await company.assertNoLiveProcesses();
      } catch (error) {
        failure = error;
        let lastEvents: EventRecord[] = [];
        try {
          lastEvents = readDatabaseEvents(
            resolveAgentTownPaths(projectRoot).databasePath
          );
        } catch (refreshError) {
          failure = new AggregateError(
            [error, refreshError],
            "E2E failed and refreshing persisted events also failed"
          );
        }
        console.error([
          failure instanceof Error
            ? formatErrorTree(failure)
            : String(failure),
          "Core stdout:",
          company?.core.stdout ?? "",
          "Core stderr:",
          company?.core.stderr ?? "",
          "last 40 events:",
          JSON.stringify(lastEvents.slice(-40), null, 2)
        ].join("\n"));
      }
      if (company !== undefined) {
        await company.dispose().catch((error: unknown) => {
          if (failure === undefined) failure = error;
        });
      }
      if (failure !== undefined) throw failure;
    },
    90_000
  );
});
