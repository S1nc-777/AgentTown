import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CapabilityReport, ProbeEvent } from "@agenttown/probe-contract";
import { redactJsonlOutput } from "./artifacts.js";
import { runParallelProbe, type ParallelProbeHandle } from "./benchmark.js";
import { parseCodexLine } from "./adapters/codex.js";
import {
  claudeInvocation,
  parseClaudeLine,
  resolveClaudeExecutable
} from "./adapters/claude.js";
import { runPty, type ProbeHandle, type PtyOptions, type RunResult } from "./pty.js";

const execFileAsync = promisify(execFile);
const INTERRUPT_MARKER = "AGENTTOWN_INTERRUPT_PROBE";
const PARALLEL_MARKERS = [
  "AGENTTOWN_PARALLEL_ONE",
  "AGENTTOWN_PARALLEL_TWO",
  "AGENTTOWN_PARALLEL_THREE"
] as const;

export interface RemainingCapabilitiesDependencies {
  initializeGit(cwd: string, timeoutMs: number): Promise<void>;
  startPty(options: PtyOptions): ProbeHandle;
  isAlive(pid: number): boolean | Promise<boolean>;
}

export interface RemainingCapabilitiesOutcome {
  agent: "codex" | "claude";
  attempted: boolean;
  interrupt: boolean;
  parallelThree: boolean;
  blockers: string[];
  orphanPids: number[];
}

export interface RemainingCapabilitiesOptions {
  artifactRootDir: string;
  timeoutMs: number;
  executable?: string;
  dependencies?: Partial<RemainingCapabilitiesDependencies>;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
    }
    throw error;
  }
}

const defaultDependencies: RemainingCapabilitiesDependencies = {
  initializeGit: async (cwd, timeoutMs) => {
    await execFileAsync("git", ["init", "--quiet"], { cwd, timeout: timeoutMs, windowsHide: true });
  },
  startPty: runPty,
  isAlive: defaultIsAlive
};

function bounded<T>(promise: Promise<T>, timeoutMs: number, blocker: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(blocker)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

function stripTerminalControls(rawOutput: string): string {
  return rawOutput
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function balancedJsonObjects(rawOutput: string): unknown[] {
  const text = stripTerminalControls(rawOutput);
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)) as unknown);
        } catch {
          // Terminal text can contain brace-shaped stderr. Only valid balanced JSON is evidence.
        }
        start = -1;
      }
    }
  }
  return values;
}

type StructuredLineParser = (line: string) => ProbeEvent[];

function terminalEvidence(
  rawOutput: string,
  parser: StructuredLineParser,
  marker?: string
): { sessionId?: string; markerSeen: boolean } {
  const events = balancedJsonObjects(rawOutput).flatMap((value) => parser(JSON.stringify(value)));
  const session = events.find((event) => event.type === "session");
  return {
    ...(session?.type !== "session" ? {} : { sessionId: session.sessionId }),
    markerSeen: marker === undefined || events.some(
      (event) => event.type === "output" && event.text.includes(marker)
    )
  };
}

function sessionObserved(rawOutput: string, parser: StructuredLineParser): boolean {
  return terminalEvidence(rawOutput, parser).sessionId !== undefined;
}

function safeTemporaryDirectory(directory: string): string {
  const root = resolve(tmpdir());
  const candidate = resolve(directory);
  const child = relative(root, candidate);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    throw new Error("Refusing unsafe capability temporary path");
  }
  return candidate;
}

async function createRepository(
  dependencies: RemainingCapabilitiesDependencies,
  timeoutMs: number
): Promise<string> {
  const directory = safeTemporaryDirectory(await mkdtemp(join(tmpdir(), "agenttown-claude-capability-")));
  try {
    await dependencies.initializeGit(directory, timeoutMs);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function waitUntilDead(
  pid: number,
  isAlive: RemainingCapabilitiesDependencies["isAlive"],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + Math.min(timeoutMs, 1_000);
  do {
    if (!(await isAlive(pid))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  } while (true);
}

function prerequisiteBlocker(report: CapabilityReport): string | undefined {
  return report.launch ? undefined : "capability_prerequisite_launch_failed";
}

function capabilityNotes(notes: string[], blockers: string[]): string[] {
  const retained = notes.filter((note) => !/^blocker:(?:capability_|interrupt_|parallel_)/u.test(note));
  return [...retained, ...blockers.map((blocker) => `blocker:${blocker}`)];
}

async function writeReportAtomically(path: string, report: CapabilityReport): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function recordOutcome(
  reportPath: string,
  report: CapabilityReport,
  outcome: RemainingCapabilitiesOutcome
): Promise<void> {
  await writeReportAtomically(reportPath, {
    ...report,
    interrupt: outcome.interrupt,
    parallelThree: outcome.parallelThree,
    notes: capabilityNotes(report.notes, outcome.blockers)
  });
}

function claudeArgs(prompt: string): string[] {
  return [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "plan"
  ];
}

interface AgentCapabilityConfig {
  executable: string;
  invocation(prompt: string, cwd: string): Pick<PtyOptions, "file" | "args">;
  parseLine: StructuredLineParser;
}

function capabilityConfig(
  agent: "codex" | "claude",
  configuredExecutable?: string
): AgentCapabilityConfig {
  if (agent === "codex") {
    const executable = configuredExecutable ?? "codex";
    return {
      executable,
      invocation: (prompt, cwd) => ({
        file: executable,
        args: ["exec", "--json", "--sandbox", "read-only", "--cd", cwd, prompt]
      }),
      parseLine: parseCodexLine
    };
  }
  const executable = resolveClaudeExecutable(configuredExecutable);
  return {
    executable,
    invocation: (prompt) => claudeInvocation(executable, claudeArgs(prompt)),
    parseLine: parseClaudeLine
  };
}

async function verifyInterrupt(
  config: AgentCapabilityConfig,
  cwd: string,
  timeoutMs: number,
  dependencies: RemainingCapabilitiesDependencies,
  logPath: string
): Promise<{ passed: boolean; blocker?: string; orphanPid?: number }> {
  const command = config.invocation(`Reply with exactly ${INTERRUPT_MARKER}`, cwd);
  let streamedRaw = "";
  const handle = dependencies.startPty({
    ...command,
    cwd,
    timeoutMs,
    onData: (text) => { streamedRaw += text; }
  });
  handle.resize(240, 60);
  const writeLog = async (
    sessionSeen: boolean,
    dead: boolean,
    completed?: RunResult
  ) => {
    const rawOutput = completed?.rawOutput ?? streamedRaw;
    await writeFile(logPath, [
      `[agenttown] session_observed:${sessionSeen}`,
      `[agenttown] process_dead:${dead}`,
      `[agenttown] bounded_exit:${completed !== undefined}`,
      `[agenttown] exit_code:${completed?.exitCode ?? "unobserved"}`,
      "[agenttown] raw_output_begin",
      redactJsonlOutput(rawOutput),
      "[agenttown] raw_output_end"
    ].join("\n") + "\n", "utf8");
  };
  try {
    await bounded(handle.waitFor((output) => sessionObserved(output, config.parseLine)), timeoutMs, "interrupt_session_timeout");
  } catch {
    handle.interrupt();
    handle.kill();
    const completed = await bounded(
      handle.completed,
      Math.min(timeoutMs + 2_500, 5_000),
      "interrupt_cleanup_timeout"
    ).catch(() => undefined);
    const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
    await writeLog(false, dead, completed);
    return dead
      ? { passed: false, blocker: "interrupt_session_not_observed" }
      : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
  }

  if (!(await dependencies.isAlive(handle.pid))) {
    handle.kill();
    const completed = await bounded(
      handle.completed,
      Math.min(timeoutMs, 1_000),
      "interrupt_early_exit_cleanup_timeout"
    ).catch(() => undefined);
    const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
    await writeLog(true, dead, completed);
    return dead
      ? { passed: false, blocker: "interrupt_process_exited_before_signal" }
      : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
  }
  handle.interrupt();
  let completed: RunResult;
  try {
    completed = await bounded(handle.completed, Math.min(timeoutMs + 2_500, 5_000), "interrupt_timeout");
  } catch {
    handle.kill();
    const killed = await bounded(handle.completed, 2_500, "interrupt_kill_timeout").catch(() => undefined);
    const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
    await writeLog(true, dead, killed);
    return dead
      ? { passed: false, blocker: "interrupt_timeout" }
      : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
  }
  const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
  await writeLog(true, dead, completed);
  return dead
    ? { passed: true }
    : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
}

function normalizedParallelHandle(
  handle: ProbeHandle,
  marker: string,
  parser: StructuredLineParser
): ParallelProbeHandle {
  return {
    pid: handle.pid,
    interrupt: () => handle.interrupt(),
    kill: () => handle.kill(),
    completed: handle.completed,
    classify: (run) => {
      if (run.timedOut) return { blocker: "timeout" };
      if (run.exitCode !== 0) return { blocker: `exit_${run.exitCode}` };
      const evidence = terminalEvidence(run.rawOutput, parser, marker);
      if (evidence.sessionId === undefined || !evidence.markerSeen) return { blocker: "exit_1" };
      return { sessionId: evidence.sessionId };
    }
  };
}

async function verifyParallelThree(
  config: AgentCapabilityConfig,
  repositories: string[],
  timeoutMs: number,
  dependencies: RemainingCapabilitiesDependencies,
  logRootDir: string
): Promise<{ passed: boolean; blockers: string[]; orphanPids: number[] }> {
  const ids = ["one", "two", "three"] as const;
  const specs = ids.map((id, index) => ({
    id,
    adapter: "claude" as const,
    prompt: PARALLEL_MARKERS[index]!,
    timeoutMs
  }));
  const summary = await runParallelProbe(specs, 3, {
    logRootDir,
    cleanupGraceMs: 100,
    orphanCheckTimeoutMs: Math.min(timeoutMs, 1_000),
    isAlive: dependencies.isAlive,
    startProbe: (spec) => {
      const index = ids.indexOf(spec.id as typeof ids[number]);
      const marker = PARALLEL_MARKERS[index]!;
      const command = config.invocation(`Reply with exactly ${marker}`, repositories[index]!);
      const handle = dependencies.startPty({
        ...command,
        cwd: repositories[index]!,
        timeoutMs
      });
      handle.resize(240, 60);
      return normalizedParallelHandle(handle, marker, config.parseLine);
    }
  });
  const blockers = summary.failed.map(({ id, blocker }) => `parallel_partial_failure:${id}:${blocker}`);
  if (summary.sessionIds.length !== new Set(summary.sessionIds).size) {
    blockers.push("parallel_duplicate_session_id");
  }
  if (summary.orphanPids.length > 0) blockers.push("parallel_orphan_process");
  return {
    passed: summary.completed.length === 3 && blockers.length === 0,
    blockers,
    orphanPids: summary.orphanPids
  };
}

export async function probeRemainingAgentCapabilities(
  agent: "codex" | "claude",
  options: RemainingCapabilitiesOptions
): Promise<RemainingCapabilitiesOutcome> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer");
  }
  const dependencies: RemainingCapabilitiesDependencies = {
    ...defaultDependencies,
    ...options.dependencies
  };
  const reportPath = resolve(options.artifactRootDir, `${agent}-real`, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as CapabilityReport;
  const prerequisite = prerequisiteBlocker(report);
  if (prerequisite !== undefined) {
    const outcome: RemainingCapabilitiesOutcome = {
      agent,
      attempted: false,
      interrupt: false,
      parallelThree: false,
      blockers: [prerequisite],
      orphanPids: []
    };
    await recordOutcome(reportPath, report, outcome);
    return outcome;
  }

  const config = capabilityConfig(agent, options.executable);
  const capabilityRoot = resolve(options.artifactRootDir, `${agent}-capabilities`);
  await mkdir(capabilityRoot, { recursive: true });
  const repositories: string[] = [];
  const blockers: string[] = [];
  const orphanPids: number[] = [];
  let interrupt = false;
  let parallelThree = false;
  try {
    for (let index = 0; index < 4; index += 1) {
      repositories.push(await createRepository(dependencies, options.timeoutMs));
    }
    const interruptResult = await verifyInterrupt(
      config,
      repositories[0]!,
      options.timeoutMs,
      dependencies,
      join(capabilityRoot, "interrupt.log")
    );
    interrupt = interruptResult.passed;
    if (interruptResult.blocker !== undefined) blockers.push(interruptResult.blocker);
    if (interruptResult.orphanPid !== undefined) orphanPids.push(interruptResult.orphanPid);

    const parallelResult = await verifyParallelThree(
      config,
      repositories.slice(1),
      options.timeoutMs,
      dependencies,
      join(capabilityRoot, "parallel")
    );
    parallelThree = parallelResult.passed;
    blockers.push(...parallelResult.blockers);
    orphanPids.push(...parallelResult.orphanPids);
  } finally {
    await Promise.all(repositories.map(async (directory) => {
      await rm(safeTemporaryDirectory(directory), { recursive: true, force: true });
    }));
  }
  const outcome: RemainingCapabilitiesOutcome = {
    agent,
    attempted: true,
    interrupt,
    parallelThree,
    blockers: [...new Set(blockers)],
    orphanPids: [...new Set(orphanPids)]
  };
  await recordOutcome(reportPath, report, outcome);
  return outcome;
}
