import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CapabilityReport } from "@agenttown/probe-contract";
import { runParallelProbe, type ParallelProbeHandle } from "./benchmark.js";
import {
  claudeInvocation,
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

function compactTerminalOutput(rawOutput: string): string {
  return rawOutput
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\s+/gu, "");
}

function terminalEvidence(rawOutput: string, marker?: string): { sessionId?: string; markerSeen: boolean } {
  const compact = compactTerminalOutput(rawOutput);
  const match = /"session_id":"([^"\\]+)"/u.exec(compact);
  return {
    ...(match?.[1] === undefined ? {} : { sessionId: match[1] }),
    markerSeen: marker === undefined || compact.includes(marker)
  };
}

function sessionObserved(rawOutput: string): boolean {
  return terminalEvidence(rawOutput).sessionId !== undefined;
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
  if (!report.launch) return "capability_prerequisite_launch_failed";
  if (!report.sessionId) return "capability_prerequisite_session_id_missing";
  if (!report.resume) return "capability_prerequisite_resume_failed";
  return undefined;
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

async function verifyInterrupt(
  executable: string,
  cwd: string,
  timeoutMs: number,
  dependencies: RemainingCapabilitiesDependencies,
  logPath: string
): Promise<{ passed: boolean; blocker?: string; orphanPid?: number }> {
  const command = claudeInvocation(executable, claudeArgs(`Reply with exactly ${INTERRUPT_MARKER}`));
  const handle = dependencies.startPty({ ...command, cwd, timeoutMs });
  handle.resize(240, 60);
  try {
    await bounded(handle.waitFor(sessionObserved), timeoutMs, "interrupt_session_timeout");
  } catch {
    handle.interrupt();
    handle.kill();
    await bounded(handle.completed, Math.min(timeoutMs + 2_500, 5_000), "interrupt_cleanup_timeout").catch(() => undefined);
    return { passed: false, blocker: "interrupt_session_not_observed" };
  }

  if (!(await dependencies.isAlive(handle.pid))) {
    await bounded(handle.completed, Math.min(timeoutMs, 1_000), "interrupt_early_exit_cleanup_timeout").catch(() => undefined);
    return { passed: false, blocker: "interrupt_process_exited_before_signal" };
  }
  handle.interrupt();
  let completed: RunResult;
  try {
    completed = await bounded(handle.completed, Math.min(timeoutMs + 2_500, 5_000), "interrupt_timeout");
  } catch {
    handle.kill();
    await bounded(handle.completed, 2_500, "interrupt_kill_timeout").catch(() => undefined);
    const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
    return dead
      ? { passed: false, blocker: "interrupt_timeout" }
      : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
  }
  const dead = await waitUntilDead(handle.pid, dependencies.isAlive, timeoutMs);
  await writeFile(logPath, [
    "[agenttown] session_observed:true",
    `[agenttown] bounded_exit:true`,
    `[agenttown] exit_code:${completed.exitCode}`
  ].join("\n") + "\n", "utf8");
  return dead
    ? { passed: true }
    : { passed: false, blocker: "interrupt_orphan_process", orphanPid: handle.pid };
}

function normalizedParallelHandle(
  handle: ProbeHandle,
  marker: string
): ParallelProbeHandle {
  return {
    pid: handle.pid,
    interrupt: () => handle.interrupt(),
    kill: () => handle.kill(),
    completed: handle.completed,
    classify: (run) => {
      if (run.timedOut) return { blocker: "timeout" };
      if (run.exitCode !== 0) return { blocker: `exit_${run.exitCode}` };
      const evidence = terminalEvidence(run.rawOutput, marker);
      if (evidence.sessionId === undefined || !evidence.markerSeen) return { blocker: "exit_1" };
      return { sessionId: evidence.sessionId };
    }
  };
}

async function verifyParallelThree(
  executable: string,
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
      const command = claudeInvocation(executable, claudeArgs(`Reply with exactly ${marker}`));
      const handle = dependencies.startPty({
        ...command,
        cwd: repositories[index]!,
        timeoutMs
      });
      handle.resize(240, 60);
      return normalizedParallelHandle(handle, marker);
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
  if (prerequisite !== undefined || agent !== "claude") {
    const blocker = prerequisite ?? "capability_adapter_not_implemented";
    const outcome: RemainingCapabilitiesOutcome = {
      agent,
      attempted: false,
      interrupt: false,
      parallelThree: false,
      blockers: [blocker],
      orphanPids: []
    };
    await recordOutcome(reportPath, report, outcome);
    return outcome;
  }

  const executable = resolveClaudeExecutable(options.executable);
  const capabilityRoot = resolve(options.artifactRootDir, "claude-capabilities");
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
      executable,
      repositories[0]!,
      options.timeoutMs,
      dependencies,
      join(capabilityRoot, "interrupt.log")
    );
    interrupt = interruptResult.passed;
    if (interruptResult.blocker !== undefined) blockers.push(interruptResult.blocker);
    if (interruptResult.orphanPid !== undefined) orphanPids.push(interruptResult.orphanPid);

    const parallelResult = await verifyParallelThree(
      executable,
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
