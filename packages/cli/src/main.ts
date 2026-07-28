import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  parseCompanyYaml,
  type RecoveryDecision,
  type TaskRecord
} from "@agenttown/runtime-contract";
import type { EventRecord } from "@agenttown/core";
import type { IpcEvent } from "@agenttown/runtime-contract";
import { AgentTownClient } from "./client.js";
import { startCore } from "./core-process.js";
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
  type EmployeeStatusView
} from "./render.js";
import {
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
  "stop"
]);

interface ParsedCommand {
  command: string;
  template: TemplateName;
  yes: boolean;
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
  if (command === undefined || !COMMANDS.has(command)) {
    throw new Error(
      "usage: agenttown <doctor|init|start|status|tasks|timeline|pause|resume|stop>"
    );
  }
  let template: TemplateName = "minimal";
  let templateSpecified = false;
  let yes = false;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--yes") {
      yes = true;
      continue;
    }
    if (value === "--template") {
      const selected = argv[index + 1];
      if (selected !== "minimal" && selected !== "parallel-software") {
        throw new Error("--template must be minimal or parallel-software");
      }
      template = selected;
      templateSpecified = true;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${String(value)}`);
  }
  if (command !== "init" && templateSpecified) {
    throw new Error("--template is valid only with init");
  }
  if (command !== "stop" && yes) throw new Error("--yes is valid only with stop");
  return { command, template, yes };
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
  return AgentTownClient.connect(pipeName, `cli-${randomUUID()}`, 0);
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
      throw new Error("AgentTown Core is not running", { cause: connectError });
    }
    return (await startCore({
      projectRoot,
      paths,
      pipeName,
      leaseTtlMs: LEASE_TTL_MS
    })).client;
  }
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

async function start(projectRoot: string, runtime: CliRuntime): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  const yaml = await readFile(paths.companyPath, "utf8");
  parseCompanyYaml(yaml);
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
      await writeWithBackpressure(
        runtime.stdout,
        `${event.sequence}\t${event.type}\n`
      );
      if (interrupted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
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
    const result = await client.request("events.list", { afterSequence: 0 });
    await writeWithBackpressure(
      runtime.stdout,
      `${renderTimeline(result as EventRecord[])}\n`
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
    await writeWithBackpressure(runtime.stdout, "paused\n");
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
  switch (parsed.command) {
    case "doctor":
      return doctor(projectRoot, runtime);
    case "init":
      await initialize(projectRoot, parsed.template, runtime);
      return 0;
    case "start":
      await start(projectRoot, runtime);
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
    default:
      throw new Error(`unsupported command: ${parsed.command}`);
  }
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  return script !== undefined
    && pathToFileURL(resolve(script)).href === import.meta.url;
}

if (isEntrypoint()) {
  void runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
