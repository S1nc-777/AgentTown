#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { realpathSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  LIVE_ONLY_AFTER_SEQUENCE,
  parseCompanyYaml,
  type ApprovalView,
  type CleanupExecuteResult,
  type CleanupPreview,
  type DeliveryView,
  type EvidenceView,
  type GitWorkspaceView,
  type RecoveryDecision,
  type TaskRecord
} from "@agenttown/runtime-contract";
import type { EventRecord } from "@agenttown/core";
import type { IpcEvent } from "@agenttown/runtime-contract";
import { AgentTownClient } from "./client.js";
import { spawnCoreDetached, startCore } from "./core-process.js";
import {
  renderApprovals,
  renderCleanupPreview,
  renderDelivery,
  renderEvidence,
  renderGitWorkspaces
} from "./git-render.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths,
  validateAgentTownWriteLayout
} from "./paths.js";
import {
  renderCompanyStatus,
  renderEmployee,
  renderTasks,
  renderTimeline,
  describeEventType,
  type EmployeeStatusView
} from "./render.js";
import {
  isTemplateName,
  TEMPLATE_NAMES,
  templateYaml,
  type TemplateName
} from "./templates.js";

const COMPANY_ID = "company";
const LEASE_TTL_MS = 15_000;
const COMMANDS = new Set([
  "doctor",
  "init",
  "start",
  "status",
  "tasks",
  "timeline",
  "pause",
  "resume",
  "stop",
  "workspaces",
  "evidence",
  "deliver",
  "approvals",
  "approve",
  "reject",
  "cleanup",
  "watch",
  "_watch"
]);

const USAGE = `agenttown - AgentTown command line

usage: agenttown <command> [options]

Commands:
  doctor         Check the environment (node, git, project writability)
  init           Initialize .agenttown/company.yaml from a template
                 (--template minimal|software-company)
  start          Start the company and stream events; with --detach,
                 start Core in the background and return immediately
  status         Show company and employee status
  tasks          List tasks
  timeline       Show the event timeline
  pause          Pause the company (checkpoint)
  resume         Resume from the latest checkpoint
  stop           Stop the company (--yes to skip confirmation)
  workspaces     List git workspaces
  evidence       Show evidence for a task (--revision N)
  deliver        Show the delivery view (integration status)
  approvals      List pending approvals
  approve        Approve an approval id (--reason "text")
  reject         Reject an approval id (--reason "text")
  cleanup        Clean up a run's worktrees (run id, --yes, --branches, --evidence)
  watch          Live terminal dashboard (company/tasks/employees/events, q to quit)
  help           Show this help

Options:
  -h, --help     Show this help
  --detach       With start: run Core in the background and return
  --template     With init: template name
  --revision     With evidence: evidence revision
  --reason       With approve/reject: decision reason
  --yes          With stop/cleanup: skip confirmation
  --branches     With cleanup: also remove branch refs
  --evidence     With cleanup: also remove evidence roots
`;

interface ParsedCommand {
  command: string;
  template: TemplateName;
  yes: boolean;
  detach: boolean;
  positional: string[];
  revision: number | undefined;
  reason: string | undefined;
  removeBranches: boolean;
  removeEvidence: boolean;
}

export interface BackpressureWritable {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

export interface CliClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  events(): AsyncIterable<IpcEvent>;
  close(): Promise<void>;
}

export interface CliRuntime {
  connectOrStart(
    projectRoot: string,
    startIfMissing: boolean
  ): Promise<CliClient>;
  stdout: BackpressureWritable;
  initializationHooks?: InitializationHooks;
}

export interface InitializationHooks {
  afterStateDirectoryReady?(paths: ReturnType<typeof resolveAgentTownPaths>): Promise<void>;
  afterLogsDirectoryReady?(paths: ReturnType<typeof resolveAgentTownPaths>): Promise<void>;
  beforeCompanyWrite?(paths: ReturnType<typeof resolveAgentTownPaths>): Promise<void>;
}

export async function writeWithBackpressure(
  stream: BackpressureWritable,
  text: string
): Promise<void> {
  if (stream.write(text)) return;
  await new Promise<void>((resolvePromise) => {
    stream.once("drain", resolvePromise);
  });
}

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === "help") {
    return {
      command: "help",
      template: "minimal",
      yes: false,
      detach: false,
      positional: [],
      revision: undefined,
      reason: undefined,
      removeBranches: false,
      removeEvidence: false
    };
  }
  if (command === undefined || !COMMANDS.has(command)) {
    throw new Error(
      "unknown command — see 'agenttown --help' for the full list"
    );
  }
  let template: TemplateName = "minimal";
  let templateSpecified = false;
  let yes = false;
  let detach = false;
  const positional: string[] = [];
  let revision: number | undefined;
  let reason: string | undefined;
  let removeBranches = false;
  let removeEvidence = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--yes") {
      yes = true;
      continue;
    }
    if (value === "--detach") {
      detach = true;
      continue;
    }
    if (value === "--template") {
      const selected = argv[index + 1];
      if (selected === undefined || !isTemplateName(selected)) {
        throw new Error(
          `--template must be one of: ${TEMPLATE_NAMES.join(", ")}`
        );
      }
      template = selected;
      templateSpecified = true;
      index += 1;
      continue;
    }
    if (value === "--revision") {
      const selected = argv[index + 1];
      const parsed = selected === undefined ? Number.NaN : Number(selected);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--revision must be a positive integer");
      }
      revision = parsed;
      index += 1;
      continue;
    }
    if (value === "--reason") {
      const selected = argv[index + 1];
      if (selected === undefined || selected.trim().length === 0) {
        throw new Error("--reason must be a non-empty user reason");
      }
      reason = selected.trim();
      index += 1;
      continue;
    }
    if (value === "--branches") {
      removeBranches = true;
      continue;
    }
    if (value === "--evidence") {
      removeEvidence = true;
      continue;
    }
    if (!value?.startsWith("--")) {
      positional.push(value ?? "");
      continue;
    }
    throw new Error(`unknown option: ${String(value)}`);
  }
  if (command !== "init" && templateSpecified) {
    throw new Error("--template is valid only with init");
  }
  if (command !== "stop" && command !== "cleanup" && yes) {
    throw new Error("--yes is valid only with stop or cleanup");
  }
  if (command !== "start" && detach) {
    throw new Error("--detach is valid only with start");
  }
  if (command !== "evidence" && revision !== undefined) {
    throw new Error("--revision is valid only with evidence");
  }
  if (command !== "approve" && command !== "reject" && reason !== undefined) {
    throw new Error("--reason is valid only with approve or reject");
  }
  if (command !== "cleanup" && (removeBranches || removeEvidence)) {
    throw new Error("--branches and --evidence are valid only with cleanup");
  }
  if (command === "evidence") {
    if (positional.length !== 1) throw new Error("evidence requires one exact task id");
  } else if (command === "approve" || command === "reject") {
    if (positional.length !== 1) throw new Error(`${command} requires one exact approval id`);
    if (reason === undefined) throw new Error(`${command} requires --reason`);
  } else if (command === "cleanup") {
    if (positional.length !== 1) throw new Error("cleanup requires one exact run id");
    if (positional[0] === "all") throw new Error("cleanup requires an exact run id, not all");
  } else if (command === "_watch") {
    if (positional.length !== 1) throw new Error("_watch requires one pipe name");
  } else if (positional.length !== 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
  return {
    command,
    template,
    yes,
    detach,
    positional,
    revision,
    reason,
    removeBranches,
    removeEvidence
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function exactIdentifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new Error(`${label} must be one exact lowercase identifier`);
  }
  return value;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function nullableUsageNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  return requiredNonnegativeInteger(value, label);
}

function employeeStatus(value: unknown): EmployeeStatusView {
  const employee = record(value, "status.snapshot employee");
  const usage = record(employee.usage, "status.snapshot usage");
  const currentTaskId = employee.currentTaskId;
  if (currentTaskId !== null && typeof currentTaskId !== "string") {
    throw new Error("status.snapshot currentTaskId must be a string or null");
  }
  return {
    id: requiredString(employee.id, "status.snapshot employee id"),
    role: requiredString(employee.role, "status.snapshot employee role"),
    status: requiredString(employee.status, "status.snapshot employee status"),
    currentTaskId,
    usage: {
      inputTokens: nullableUsageNumber(
        usage.inputTokens,
        "status.snapshot inputTokens"
      ),
      outputTokens: nullableUsageNumber(
        usage.outputTokens,
        "status.snapshot outputTokens"
      ),
      contextTokens: nullableUsageNumber(
        usage.contextTokens,
        "status.snapshot contextTokens"
      ),
      capturedAt: requiredString(
        usage.capturedAt,
        "status.snapshot capturedAt"
      )
    }
  };
}

async function connectExisting(pipeName: string): Promise<AgentTownClient> {
  return AgentTownClient.connect(
    pipeName,
    `cli-${randomUUID()}`,
    LIVE_ONLY_AFTER_SEQUENCE
  );
}

async function connectOrStart(
  projectRoot: string,
  startIfMissing: boolean
): Promise<AgentTownClient> {
  const paths = resolveAgentTownPaths(projectRoot);
  const pipeName = pipeNameForProject(projectRoot);
  try {
    return await connectExisting(pipeName);
  } catch (connectError) {
    if (!startIfMissing) {
      throw new Error(
        "AgentTown Core is not running — run 'agenttown start' first",
        { cause: connectError }
      );
    }
    return (await startCore({
      projectRoot,
      paths,
      pipeName,
      leaseTtlMs: LEASE_TTL_MS
    })).client;
  }
}

/**
 * Commands that need a configured company. Everything except doctor/init
 * and the internal watcher requires `.agenttown/company.yaml`; without it
 * the user gets a raw ENOENT, so fail with a helpful hint instead.
 */
const COMMANDS_REQUIRING_INIT = new Set([
  "start",
  "status",
  "tasks",
  "timeline",
  "pause",
  "resume",
  "stop",
  "workspaces",
  "evidence",
  "deliver",
  "approvals",
  "approve",
  "reject",
  "cleanup",
  "watch"
]);

async function assertInitialized(projectRoot: string): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  try {
    await access(paths.companyPath, fsConstants.R_OK);
  } catch {
    throw new Error(
      `this project is not initialized (missing ${paths.companyPath}) — run 'agenttown init' first`
    );
  }
}

/**
 * Translates raw Core error messages into user-facing hints for the common
 * lifecycle mix-ups a human is likely to hit.
 */
function friendlyError(error: Error): string {
  const message = error.message;
  if (/company is paused/u.test(message)) {
    return "company is paused — run 'agenttown resume' to continue";
  }
  if (/invalid_lifecycle_state/u.test(message)) {
    return `${message} — check 'agenttown status' or run 'agenttown resume'`;
  }
  if (/not initialized/u.test(message)) {
    return message;
  }
  return message;
}

async function doctor(
  projectRoot: string,
  runtime: CliRuntime
): Promise<number> {
  const checks: Array<[string, boolean, string]> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(["node", Number.isInteger(nodeMajor) && nodeMajor >= 22, process.version]);
  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000
  });
  checks.push([
    "git",
    git.status === 0,
    git.status === 0 ? git.stdout.trim() : "unavailable"
  ]);
  let writable = true;
  try {
    await access(projectRoot, fsConstants.W_OK);
  } catch {
    writable = false;
  }
  checks.push(["project-write", writable, projectRoot]);
  let fakeAvailable = true;
  try {
    await access(process.execPath, fsConstants.X_OK);
  } catch {
    fakeAvailable = false;
  }
  checks.push(["fake-agent", fakeAvailable, fakeAvailable ? process.execPath : "unavailable"]);
  for (const [name, ok, detail] of checks) {
    await writeWithBackpressure(
      runtime.stdout,
      `${ok ? "ok" : "fail"}\t${name}\t${detail}\n`
    );
  }
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

async function initialize(
  projectRoot: string,
  template: TemplateName,
  runtime: CliRuntime
): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  await validateAgentTownWriteLayout(paths);
  await ensureExactDirectory(paths.stateDir);
  await runtime.initializationHooks?.afterStateDirectoryReady?.(paths);
  await validateAgentTownWriteLayout(paths);
  await ensureExactDirectory(paths.logsDir);
  await runtime.initializationHooks?.afterLogsDirectoryReady?.(paths);
  await validateAgentTownWriteLayout(paths);
  const yaml = templateYaml(template);
  parseCompanyYaml(yaml);
  await runtime.initializationHooks?.beforeCompanyWrite?.(paths);
  await validateAgentTownWriteLayout(paths);
  await writeFile(paths.companyPath, yaml, { encoding: "utf8", flag: "wx" });
  await validateAgentTownWriteLayout(paths);
  await writeWithBackpressure(runtime.stdout, `initialized ${paths.companyPath}\n`);
}

async function ensureExactDirectory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !("code" in error)
      || (error as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw error;
    }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`AgentTown directory is not a real directory: ${path}`);
  }
}

async function start(
  projectRoot: string,
  runtime: CliRuntime,
  detach: boolean
): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  const yaml = await readFile(paths.companyPath, "utf8");
  parseCompanyYaml(yaml);
  if (detach) {
    await startDetached(projectRoot, paths, runtime);
    return;
  }
  const client = await runtime.connectOrStart(projectRoot, true);
  await client.request("company.start", {});
  await writeWithBackpressure(runtime.stdout, "running\n");
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void client.close();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    for await (const event of client.events()) {
      const description = describeEventType(event.type);
      await writeWithBackpressure(
        runtime.stdout,
        `${event.sequence}\t${event.type}${description.length === 0 ? "" : `\t${description}`}\n`
      );
      if (interrupted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await client.close();
  }
}

/**
 * `agenttown start --detach`: starts Core in the background (logging to
 * .agenttown/core.log), issues company.start, then spawns a detached
 * watcher process that holds a client connection (the client heartbeats the
 * lease automatically, so Core stays alive without a foreground terminal),
 * and returns immediately.
 */
async function startDetached(
  projectRoot: string,
  paths: ReturnType<typeof resolveAgentTownPaths>,
  runtime: CliRuntime
): Promise<void> {
  const pipeName = pipeNameForProject(projectRoot);
  let client: AgentTownClient;
  try {
    client = await connectExisting(pipeName);
  } catch {
    client = await spawnCoreDetached({
      projectRoot,
      paths,
      pipeName,
      leaseTtlMs: LEASE_TTL_MS
    });
  }
  try {
    await client.request("company.start", {});
  } finally {
    await client.close();
  }
  // Detached watcher keeps the lease alive in the background.
  const entry = fileURLToPath(import.meta.url);
  const watcher = spawn(
    process.execPath,
    [entry, "_watch", pipeName],
    {
      cwd: projectRoot,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: process.env
    }
  );
  watcher.unref();
  await writeWithBackpressure(runtime.stdout, "running (detached)\n");
}

/**
 * Internal background process for `start --detach`: holds a client
 * connection (heartbeats the lease) and consumes the event stream until
 * Core goes away.
 */
async function watch(pipeName: string): Promise<number> {
  const client = await connectExisting(pipeName);
  try {
    for await (const _event of client.events()) {
      // Keeping the connection alive maintains the lease; events are
      // intentionally not printed (they remain fully queryable via
      // `agenttown timeline`).
    }
  } finally {
    await client.close();
  }
  return 0;
}

const WATCH_REFRESH_MS = 1_000;
const WATCH_EVENT_LIMIT = 25;

/**
 * `agenttown watch`: live terminal dashboard. Every second it repaints the
 * company status, task list, employee states and the most recent events.
 * Press q to quit; on a non-TTY it prints a single snapshot instead.
 */
async function watchDashboard(
  projectRoot: string,
  runtime: CliRuntime
): Promise<number> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const refresh = async (): Promise<string> => {
      const snapshot = record(
        await client.request("status.snapshot", { companyId: COMPANY_ID }),
        "status.snapshot"
      );
      if (!Array.isArray(snapshot.employees)) {
        throw new Error("status.snapshot employees must be an array");
      }
      const employees = snapshot.employees
        .map(employeeStatus)
        .sort((left, right) => left.id.localeCompare(right.id));
      const tasksResult = await client.request("tasks.list", {
        companyId: COMPANY_ID
      }) as TaskRecord[];
      const events = await client.request("events.list", {
        afterSequence: 0,
        limit: WATCH_EVENT_LIMIT
      }) as EventRecord[];
      const timelineLines = renderTimeline(events).split("\n");
      return [
        `AgentTown  ${new Date().toISOString()}  (q 退出)`,
        "─".repeat(68),
        renderCompanyStatus({
          companyId: requiredString(snapshot.companyId, "status.snapshot companyId"),
          status: requiredString(snapshot.status, "status.snapshot status"),
          activeTaskCount: requiredNonnegativeInteger(
            snapshot.activeTaskCount,
            "status.snapshot activeTaskCount"
          ),
          pendingApprovalCount: requiredNonnegativeInteger(
            snapshot.pendingApprovalCount,
            "status.snapshot pendingApprovalCount"
          )
        }),
        "",
        renderTasks(tasksResult),
        "",
        ...employees.flatMap((employee) => [
          renderEmployee(employee),
          ""
        ]),
        `最新事件（最近 ${WATCH_EVENT_LIMIT} 条）:`,
        ...timelineLines.slice(-WATCH_EVENT_LIMIT)
      ].join("\n");
    };

    if (!process.stdout.isTTY) {
      await writeWithBackpressure(runtime.stdout, `${await refresh()}\n`);
      return 0;
    }

    let exit = false;
    const onKey = (chunk: Buffer | string) => {
      if (String(chunk).toLowerCase().includes("q")) exit = true;
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onKey);
    try {
      while (!exit) {
        const frame = await refresh();
        await writeWithBackpressure(
          runtime.stdout,
          `\x1b[2J\x1b[H${frame}\n`
        );
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, WATCH_REFRESH_MS);
        });
      }
    } finally {
      process.stdin.off("data", onKey);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
    }
    return 0;
  } finally {
    await client.close();
  }
}

async function status(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const snapshot = record(
      await client.request("status.snapshot", { companyId: COMPANY_ID }),
      "status.snapshot"
    );
    if (!Array.isArray(snapshot.employees)) {
      throw new Error("status.snapshot employees must be an array");
    }
    const employees = snapshot.employees
      .map(employeeStatus)
      .sort((left, right) => left.id.localeCompare(right.id));
    const output = [
      renderCompanyStatus({
        companyId: requiredString(
          snapshot.companyId,
          "status.snapshot companyId"
        ),
        status: requiredString(snapshot.status, "status.snapshot status"),
        activeTaskCount: requiredNonnegativeInteger(
          snapshot.activeTaskCount,
          "status.snapshot activeTaskCount"
        ),
        pendingApprovalCount: requiredNonnegativeInteger(
          snapshot.pendingApprovalCount,
          "status.snapshot pendingApprovalCount"
        )
      }),
      ...employees.map(renderEmployee)
    ].join("\n\n");
    await writeWithBackpressure(runtime.stdout, `${output}\n`);
  } finally {
    await client.close();
  }
}

async function tasks(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const result = await client.request("tasks.list", { companyId: COMPANY_ID });
    await writeWithBackpressure(
      runtime.stdout,
      `${renderTasks(result as TaskRecord[])}\n`
    );
  } finally {
    await client.close();
  }
}

async function timeline(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const result: EventRecord[] = [];
    let afterSequence = 0;
    while (true) {
      const page = await client.request("events.list", {
        afterSequence,
        limit: 32
      }) as EventRecord[];
      result.push(...page);
      if (page.length < 32) break;
      afterSequence = page.at(-1)!.sequence;
    }
    await writeWithBackpressure(
      runtime.stdout,
      `${renderTimeline(result)}\n`
    );
  } finally {
    await client.close();
  }
}

async function requestAndRender(
  projectRoot: string,
  runtime: CliRuntime,
  method: string,
  params: Record<string, unknown>,
  render: (value: unknown) => string
): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    await writeWithBackpressure(
      runtime.stdout,
      `${render(await client.request(method, params))}\n`
    );
  } finally {
    await client.close();
  }
}

async function decideApproval(
  projectRoot: string,
  runtime: CliRuntime,
  approvalId: string,
  decision: "approved" | "rejected",
  reason: string
): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const result = record(await client.request("approvals.decide", {
      approvalId,
      decision,
      reason
    }), "approvals.decide");
    if (result.status !== decision) {
      throw new Error("Core did not confirm approval decision");
    }
    await writeWithBackpressure(runtime.stdout, `${decision}\n`);
  } finally {
    await client.close();
  }
}

async function confirmCleanup(yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error("cleanup requires --yes in noninteractive mode");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Execute this exact cleanup? [y/N] ");
    if (!/^y(?:es)?$/iu.test(answer.trim())) throw new Error("cleanup cancelled");
  } finally {
    prompt.close();
  }
}

async function cleanup(
  projectRoot: string,
  runtime: CliRuntime,
  parsed: ParsedCommand
): Promise<void> {
  await confirmCleanup(parsed.yes);
  const runId = exactIdentifier(parsed.positional[0]!, "run id");
  const selection = {
    runId,
    removeWorktrees: true,
    removeBranches: parsed.removeBranches,
    removeEvidence: parsed.removeEvidence
  };
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const preview = await client.request(
      "git.cleanup.preview",
      selection
    ) as CleanupPreview;
    await writeWithBackpressure(runtime.stdout, `${renderCleanupPreview(preview)}\n`);
    const result = await client.request("git.cleanup.execute", {
      ...selection,
      fingerprint: requiredString(preview.fingerprint, "cleanup fingerprint")
    }) as CleanupExecuteResult;
    await writeWithBackpressure(
      runtime.stdout,
      `removed worktrees=${result.removedWorkspaces} branches=${result.removedBranches} evidence=${result.removedEvidenceRoots}\n`
    );
  } finally {
    await client.close();
  }
}

async function pause(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const result = record(
      await client.request("company.pause", {}),
      "company.pause"
    );
    if (result.status !== "paused") throw new Error("Core did not confirm paused");
    await writeWithBackpressure(
      runtime.stdout,
      "paused\n公司已暂停。下次继续：先运行 'agenttown start'，再运行 'agenttown resume'\n"
    );
  } finally {
    await client.close();
  }
}

async function resume(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const client = await runtime.connectOrStart(projectRoot, true);
  try {
    const result = record(
      await client.request("company.resume", {}),
      "company.resume"
    );
    const decisions = result.decisions;
    if (!Array.isArray(decisions)) throw new Error("Core omitted recovery decisions");
    for (const decision of decisions as RecoveryDecision[]) {
      await writeWithBackpressure(
        runtime.stdout,
        `${decision.employeeId}\t${decision.mode}\n`
      );
    }
  } finally {
    await client.close();
  }
}

async function confirmStop(yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new Error("stop requires --yes in noninteractive mode");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Stop AgentTown? [y/N] ");
    if (!/^y(?:es)?$/iu.test(answer.trim())) throw new Error("stop cancelled");
  } finally {
    prompt.close();
  }
}

async function stop(
  projectRoot: string,
  yes: boolean,
  runtime: CliRuntime
): Promise<void> {
  await confirmStop(yes);
  const client = await runtime.connectOrStart(projectRoot, false);
  try {
    const result = record(await client.request("company.stop", {}), "company.stop");
    if (result.status !== "stopped" && result.status !== "stopping") {
      throw new Error("Core did not confirm stop");
    }
    await writeWithBackpressure(runtime.stdout, `${String(result.status)}\n`);
  } finally {
    await client.close();
  }
}

export async function runCli(
  argv: readonly string[],
  projectRoot = process.cwd(),
  overrides: Partial<CliRuntime> = {}
): Promise<number> {
  const parsed = parseCommand(argv);
  const runtime: CliRuntime = {
    connectOrStart,
    stdout: process.stdout,
    ...overrides
  };
  if (COMMANDS_REQUIRING_INIT.has(parsed.command)) {
    await assertInitialized(projectRoot);
  }
  switch (parsed.command) {
    case "help":
      await writeWithBackpressure(runtime.stdout, USAGE);
      return 0;
    case "_watch":
      return watch(requiredString(parsed.positional[0], "pipe name"));
    case "doctor":
      return doctor(projectRoot, runtime);
    case "init":
      await initialize(projectRoot, parsed.template, runtime);
      return 0;
    case "start":
      await start(projectRoot, runtime, parsed.detach);
      return 0;
    case "status":
      await status(projectRoot, runtime);
      return 0;
    case "tasks":
      await tasks(projectRoot, runtime);
      return 0;
    case "timeline":
      await timeline(projectRoot, runtime);
      return 0;
    case "pause":
      await pause(projectRoot, runtime);
      return 0;
    case "resume":
      await resume(projectRoot, runtime);
      return 0;
    case "stop":
      await stop(projectRoot, parsed.yes, runtime);
      return 0;
    case "workspaces":
      await requestAndRender(projectRoot, runtime, "git.workspaces.list", {},
        (value) => renderGitWorkspaces(value as GitWorkspaceView[]));
      return 0;
    case "evidence": {
      const taskId = exactIdentifier(parsed.positional[0]!, "task id");
      await requestAndRender(
        projectRoot,
        runtime,
        "git.evidence.get",
        {
          taskId,
          ...(parsed.revision === undefined ? {} : { revision: parsed.revision })
        },
        (value) => renderEvidence(value as EvidenceView)
      );
      return 0;
    }
    case "deliver":
      await requestAndRender(projectRoot, runtime, "git.delivery.get", {},
        (value) => renderDelivery(value as DeliveryView));
      return 0;
    case "approvals":
      await requestAndRender(projectRoot, runtime, "approvals.list", {},
        (value) => renderApprovals(value as ApprovalView[]));
      return 0;
    case "approve":
    case "reject":
      await decideApproval(
        projectRoot,
        runtime,
        requiredString(parsed.positional[0], "approval id"),
        parsed.command === "approve" ? "approved" : "rejected",
        parsed.reason!
      );
      return 0;
    case "cleanup":
      await cleanup(projectRoot, runtime, parsed);
      return 0;
    case "watch":
      await watchDashboard(projectRoot, runtime);
      return 0;
    default:
      throw new Error(`unsupported command: ${parsed.command}`);
  }
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    // resolve symlinks/junctions so the check also works when the CLI is
    // invoked through a global npm link (argv[1] is the link path while
    // import.meta.url is the real path Node resolved at load time).
    return pathToFileURL(realpathSync(script)).href === import.meta.url;
  } catch {
    return pathToFileURL(resolve(script)).href === import.meta.url;
  }
}

if (isEntrypoint()) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? friendlyError(error) : String(error)}\n`
      );
      process.exitCode = 1;
    }
  );
}
