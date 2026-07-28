import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
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
import { AgentTownClient } from "./client.js";
import { startCore } from "./core-process.js";
import {
  pipeNameForProject,
  resolveAgentTownPaths
} from "./paths.js";
import {
  renderCompanyStatus,
  renderTasks,
  renderTimeline
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

function parseCommand(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command === undefined || !COMMANDS.has(command)) {
    throw new Error(
      "usage: agenttown <doctor|init|start|status|tasks|timeline|pause|resume|stop>"
    );
  }
  let template: TemplateName = "minimal";
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
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${String(value)}`);
  }
  if (command !== "init" && template !== "minimal") {
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

async function doctor(projectRoot: string): Promise<number> {
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
    process.stdout.write(`${ok ? "ok" : "fail"}\t${name}\t${detail}\n`);
  }
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

async function initialize(projectRoot: string, template: TemplateName): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  await mkdir(paths.logsDir, { recursive: true });
  const yaml = templateYaml(template);
  parseCompanyYaml(yaml);
  await writeFile(paths.companyPath, yaml, { encoding: "utf8", flag: "wx" });
  process.stdout.write(`initialized ${paths.companyPath}\n`);
}

async function start(projectRoot: string): Promise<void> {
  const paths = resolveAgentTownPaths(projectRoot);
  const yaml = await readFile(paths.companyPath, "utf8");
  parseCompanyYaml(yaml);
  const client = await connectOrStart(projectRoot, true);
  await client.request("company.start", {});
  process.stdout.write("running\n");
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    void client.close();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    for await (const event of client.events()) {
      process.stdout.write(`${event.sequence}\t${event.type}\n`);
      if (interrupted) break;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await client.close();
  }
}

async function status(projectRoot: string): Promise<void> {
  const client = await connectOrStart(projectRoot, false);
  try {
    const [company, tasks, events] = await Promise.all([
      client.request("company.status", { companyId: COMPANY_ID }),
      client.request("tasks.list", { companyId: COMPANY_ID }),
      client.request("events.list", { afterSequence: 0 })
    ]);
    const companyFact = record(company, "company.status");
    const taskRecords = tasks as TaskRecord[];
    const eventRecords = events as EventRecord[];
    process.stdout.write(`${renderCompanyStatus({
      companyId: COMPANY_ID,
      status: typeof companyFact.status === "string" ? companyFact.status : "unknown",
      activeTaskCount: taskRecords.filter(
        ({ status: taskStatus }) => taskStatus === "running" || taskStatus === "review"
      ).length,
      pendingApprovalCount: eventRecords.filter(
        ({ type }) => type === "user.approval.requested"
      ).length
    })}\n`);
  } finally {
    await client.close();
  }
}

async function tasks(projectRoot: string): Promise<void> {
  const client = await connectOrStart(projectRoot, false);
  try {
    const result = await client.request("tasks.list", { companyId: COMPANY_ID });
    process.stdout.write(`${renderTasks(result as TaskRecord[])}\n`);
  } finally {
    await client.close();
  }
}

async function timeline(projectRoot: string): Promise<void> {
  const client = await connectOrStart(projectRoot, false);
  try {
    const result = await client.request("events.list", { afterSequence: 0 });
    process.stdout.write(`${renderTimeline(result as EventRecord[])}\n`);
  } finally {
    await client.close();
  }
}

async function pause(projectRoot: string): Promise<void> {
  const client = await connectOrStart(projectRoot, false);
  try {
    const result = record(
      await client.request("company.pause", {}),
      "company.pause"
    );
    if (result.status !== "paused") throw new Error("Core did not confirm paused");
    process.stdout.write("paused\n");
  } finally {
    await client.close();
  }
}

async function resume(projectRoot: string): Promise<void> {
  const client = await connectOrStart(projectRoot, true);
  try {
    const result = record(
      await client.request("company.resume", {}),
      "company.resume"
    );
    const decisions = result.decisions;
    if (!Array.isArray(decisions)) throw new Error("Core omitted recovery decisions");
    for (const decision of decisions as RecoveryDecision[]) {
      process.stdout.write(`${decision.employeeId}\t${decision.mode}\n`);
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

async function stop(projectRoot: string, yes: boolean): Promise<void> {
  await confirmStop(yes);
  const client = await connectOrStart(projectRoot, false);
  try {
    const result = record(await client.request("company.stop", {}), "company.stop");
    if (result.status !== "stopped" && result.status !== "stopping") {
      throw new Error("Core did not confirm stop");
    }
    process.stdout.write(`${String(result.status)}\n`);
  } finally {
    await client.close();
  }
}

export async function runCli(
  argv: readonly string[],
  projectRoot = process.cwd()
): Promise<number> {
  const parsed = parseCommand(argv);
  switch (parsed.command) {
    case "doctor":
      return doctor(projectRoot);
    case "init":
      await initialize(projectRoot, parsed.template);
      return 0;
    case "start":
      await start(projectRoot);
      return 0;
    case "status":
      await status(projectRoot);
      return 0;
    case "tasks":
      await tasks(projectRoot);
      return 0;
    case "timeline":
      await timeline(projectRoot);
      return 0;
    case "pause":
      await pause(projectRoot);
      return 0;
    case "resume":
      await resume(projectRoot);
      return 0;
    case "stop":
      await stop(projectRoot, parsed.yes);
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
