import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProbeEvent, type ProbeEvent } from "@agenttown/probe-contract";
import { runPty, type RunResult } from "./pty.js";

export interface ParallelProbeSpec {
  id: string;
  adapter: "fake" | "codex" | "claude";
  prompt: string;
  mode?: "normal" | "slow" | "silent" | "crash";
  timeoutMs?: number;
}

export interface ParallelProbeFailure {
  id: string;
  blocker: string;
}

export interface ParallelProbeSummary {
  completed: string[];
  failed: ParallelProbeFailure[];
  sessionIds: string[];
  elapsedMs: number;
  peakCoreMemoryBytes: number;
  orphanPids: number[];
  logFiles: string[];
}

export interface ParallelProbeHandle {
  pid: number;
  completed: Promise<RunResult>;
  classify?(result: RunResult): { sessionId?: string; blocker?: string };
  interrupt(): void;
  kill(): void;
}

export interface ParallelProbeOptions {
  startProbe?: (spec: ParallelProbeSpec) => ParallelProbeHandle;
  logRootDir?: string;
  cleanupGraceMs?: number;
  isAlive?: (pid: number) => boolean | Promise<boolean>;
  orphanCheckTimeoutMs?: number;
  orphanPollIntervalMs?: number;
}

const fakeAgentPath = fileURLToPath(new URL("../../fake-agent/src/cli.ts", import.meta.url));
const defaultLogRoot = fileURLToPath(new URL("../../../artifacts/feasibility/parallel-fake/", import.meta.url));
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DEFAULT_ORPHAN_CHECK_TIMEOUT_MS = 250;
const DEFAULT_ORPHAN_POLL_INTERVAL_MS = 25;

function startFakeProbe(spec: ParallelProbeSpec): ParallelProbeHandle {
  if (spec.adapter !== "fake") {
    throw new Error(`parallel adapter is not implemented: ${spec.adapter}`);
  }
  return runPty({
    file: process.execPath,
    args: [
      "--import", "tsx", fakeAgentPath,
      "--mode", spec.mode ?? "normal",
      "--prompt", spec.prompt
    ],
    cwd: dirname(fakeAgentPath),
    timeoutMs: spec.timeoutMs ?? 10_000
  });
}

function parseEvents(rawOutput: string): ProbeEvent[] {
  const plainOutput = rawOutput
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
  return plainOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseProbeEvent);
}

function classify(spec: ParallelProbeSpec, result: RunResult): { sessionId?: string; blocker?: string } {
  const events = parseEvents(result.rawOutput);
  const session = events.find(
    (event): event is Extract<ProbeEvent, { type: "session" }> => event.type === "session"
  );
  if (result.timedOut) return { blocker: "timeout" };
  if (result.exitCode !== 0) return { blocker: `exit_${result.exitCode}` };
  if (events.some((event) => event.type === "parse_error")) return { blocker: "parse_failure" };
  if (!events.some((event) => event.type === "completed" && event.exitCode === 0)) {
    return { blocker: "completion_missing" };
  }
  if (session === undefined) return { blocker: "session_id_missing" };
  return { sessionId: session.sessionId };
}

function startFailureBlocker(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      return `start_${code}`;
    }
  }
  return "start_failed";
}

async function cleanupHandles(
  handles: Iterable<ParallelProbeHandle>,
  graceMs: number
): Promise<unknown[]> {
  const unfinished = [...handles];
  const errors: unknown[] = [];
  if (unfinished.length === 0) return errors;
  for (const handle of unfinished) {
    try {
      handle.interrupt();
    } catch (error) {
      errors.push(error);
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  for (const handle of unfinished) {
    try {
      handle.kill();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
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

async function findOrphanPids(
  pids: Iterable<number>,
  isAlive: (pid: number) => boolean | Promise<boolean>,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<number[]> {
  let survivors = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const deadline = Date.now() + timeoutMs;
  while (survivors.length > 0) {
    survivors = (await Promise.all(survivors.map(async (pid) => ({
      pid,
      alive: await isAlive(pid)
    })))).filter(({ alive }) => alive).map(({ pid }) => pid);
    if (survivors.length === 0 || Date.now() >= deadline) return survivors;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())));
  }
  return survivors;
}

export async function runParallelProbe(
  specs: ParallelProbeSpec[],
  concurrency: number,
  options: ParallelProbeOptions = {}
): Promise<ParallelProbeSummary> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  if (specs.some((spec) => !PORTABLE_ID.test(spec.id))) {
    throw new Error("probe id must be a portable 1-64 character path segment");
  }
  if (new Set(specs.map(({ id }) => id)).size !== specs.length) {
    throw new Error("probe ids must be unique");
  }

  const startedAt = Date.now();
  const outcomes: Array<{ sessionId?: string; blocker?: string } | undefined> = Array(specs.length);
  const logFiles: string[] = Array(specs.length);
  let nextIndex = 0;
  let peakCoreMemoryBytes = process.memoryUsage.rss();
  const logRootDir = options.logRootDir ?? defaultLogRoot;
  const startProbe = options.startProbe ?? startFakeProbe;
  const cleanupGraceMs = options.cleanupGraceMs ?? 100;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const orphanCheckTimeoutMs = options.orphanCheckTimeoutMs ?? DEFAULT_ORPHAN_CHECK_TIMEOUT_MS;
  const orphanPollIntervalMs = options.orphanPollIntervalMs ?? DEFAULT_ORPHAN_POLL_INTERVAL_MS;
  const activeHandles = new Set<ParallelProbeHandle>();
  const startedPids: number[] = [];
  await mkdir(logRootDir, { recursive: true });

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      const spec = specs[index];
      if (spec === undefined) return;
      let handle: ParallelProbeHandle;
      try {
        handle = startProbe(spec);
      } catch (error) {
        const blocker = startFailureBlocker(error);
        const logFile = `${spec.id}.log`;
        await writeFile(join(logRootDir, logFile), `[agenttown] blocker:${blocker}\n`, "utf8");
        logFiles[index] = logFile;
        outcomes[index] = { blocker };
        continue;
      }
      activeHandles.add(handle);
      startedPids.push(handle.pid);
      peakCoreMemoryBytes = Math.max(peakCoreMemoryBytes, process.memoryUsage.rss());
      const result = await handle.completed;
      activeHandles.delete(handle);
      const logFile = `${spec.id}.log`;
      await writeFile(join(logRootDir, logFile), result.rawOutput, "utf8");
      logFiles[index] = logFile;
      outcomes[index] = handle.classify?.(result) ?? classify(spec, result);
      peakCoreMemoryBytes = Math.max(peakCoreMemoryBytes, process.memoryUsage.rss());
    }
  };

  let workerError: unknown;
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, specs.length) }, worker));
  } catch (error) {
    workerError = error;
  }
  const cleanupErrors = await cleanupHandles(activeHandles, cleanupGraceMs);
  if (workerError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError([workerError, ...cleanupErrors], "Parallel probe failed and cleanup reported errors");
    }
    throw workerError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Parallel probe cleanup reported errors");
  }
  const orphanPids = await findOrphanPids(
    startedPids,
    isAlive,
    orphanCheckTimeoutMs,
    orphanPollIntervalMs
  );
  const completed: string[] = [];
  const failed: ParallelProbeFailure[] = [];
  const sessionIds: string[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index]!;
    const outcome = outcomes[index]!;
    if (outcome.blocker !== undefined) failed.push({ id: spec.id, blocker: outcome.blocker });
    else {
      completed.push(spec.id);
      sessionIds.push(outcome.sessionId!);
    }
  }

  return {
    completed,
    failed,
    sessionIds,
    elapsedMs: Date.now() - startedAt,
    peakCoreMemoryBytes,
    orphanPids,
    logFiles
  };
}
