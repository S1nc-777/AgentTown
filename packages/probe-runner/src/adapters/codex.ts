import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CapabilityReport, ProbeEvent } from "@agenttown/probe-contract";
import { writeProbeArtifacts } from "../artifacts.js";
import { runProcess as defaultRunProcess } from "../process.js";
import type { PtyOptions, RunResult } from "../pty.js";

const FIRST_PROMPT = "Reply with exactly AGENTTOWN_PROBE_OK";
const RESUME_PROMPT = "Reply with exactly AGENTTOWN_RESUME_OK";

export type ProcessRunner = (options: PtyOptions) => Promise<RunResult>;

export interface ProbeCodexOptions {
  timeoutMs: number;
  artifactRootDir?: string;
  runId?: string;
  executable?: string;
  gitExecutable?: string;
  runProcess?: ProcessRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failureMessage(value: Record<string, unknown>): string | undefined {
  if (typeof value.message === "string") return value.message;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return undefined;
}

export function parseCodexLine(line: string): ProbeEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [{ type: "parse_error", raw: line, reason: "invalid_json" }];
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
  }

  if (value.type === "thread.started") {
    return typeof value.thread_id === "string"
      ? [{ type: "session", sessionId: value.thread_id }]
      : [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
  }

  if (value.type === "item.completed" && isRecord(value.item) && value.item.type === "agent_message") {
    return typeof value.item.text === "string"
      ? [{ type: "output", text: value.item.text }]
      : [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
  }

  if (value.type === "turn.completed") {
    if (!isRecord(value.usage)
      || typeof value.usage.input_tokens !== "number"
      || typeof value.usage.output_tokens !== "number") {
      return [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
    }
    return typeof value.usage.cached_input_tokens === "number"
      ? [{
          type: "usage",
          inputTokens: value.usage.input_tokens,
          cachedInputTokens: value.usage.cached_input_tokens,
          outputTokens: value.usage.output_tokens
        }]
      : [{
          type: "usage",
          inputTokens: value.usage.input_tokens,
          outputTokens: value.usage.output_tokens
        }];
  }

  if (value.type === "turn.failed" || value.type === "error") {
    const message = failureMessage(value);
    return message === undefined
      ? [{ type: "parse_error", raw: line, reason: "unknown_shape" }]
      : [{ type: "output", text: message }];
  }

  return [];
}

function parseOutput(rawOutput: string): ProbeEvent[] {
  return rawOutput
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .flatMap(parseCodexLine);
}

function containsOutput(events: ProbeEvent[], text: string): boolean {
  return events.some((event) => event.type === "output" && event.text.includes(text));
}

function containsAuthenticationFailure(rawOutput: string): boolean {
  return /authentication|not logged in|unauthori[sz]ed|login required|\b401\b/iu.test(rawOutput);
}

interface KnownLaunchFailure {
  blocker: "executable_not_found" | "launch_failed";
  code: "ENOENT" | "EACCES" | "EPERM";
}

function knownLaunchFailure(error: unknown): KnownLaunchFailure | undefined {
  if (!isRecord(error)) return undefined;
  if (error.code === "ENOENT") return { blocker: "executable_not_found", code: "ENOENT" };
  if (error.code === "EACCES") return { blocker: "launch_failed", code: "EACCES" };
  if (error.code === "EPERM") return { blocker: "launch_failed", code: "EPERM" };
  return undefined;
}

function combineRuns(runs: RunResult[], fallbackRawOutput = ""): RunResult {
  const rawOutput = runs.length === 0
    ? fallbackRawOutput
    : runs.map((run) => run.rawOutput).filter((text) => text.length > 0).join("\n");
  const lastRun = runs.at(-1);
  return {
    command: lastRun?.command ?? [],
    startedAt: runs[0]?.startedAt ?? new Date().toISOString(),
    durationMs: runs.reduce((total, run) => total + run.durationMs, 0),
    exitCode: lastRun?.exitCode ?? -1,
    rawOutput,
    timedOut: runs.some((run) => run.timedOut)
  };
}

function defaultRunId(): string {
  return `codex-${Date.now()}-${process.pid}`;
}

export async function probeCodex(options: ProbeCodexOptions): Promise<CapabilityReport> {
  const startedAt = Date.now();
  const execute = options.runProcess ?? defaultRunProcess;
  const executable = options.executable ?? "codex";
  const gitExecutable = options.gitExecutable ?? "git";
  const artifactRootDir = options.artifactRootDir ?? resolve(process.cwd(), "artifacts", "feasibility");
  const runId = options.runId ?? defaultRunId();
  const firstArgs = ["exec", "--json", "--sandbox", "read-only", "--cd", "<temp-repo>", FIRST_PROMPT];
  const predictedRawLogPath = join(resolve(artifactRootDir), runId, "raw.log");
  const runs: RunResult[] = [];
  const events: ProbeEvent[] = [];
  const notes: string[] = [];
  let temporaryRepository: string | undefined;
  let version = "unknown";
  let launch = false;
  let streamOutput = false;
  let sessionId = false;
  let resume = false;
  let tokenUsage = false;
  let nonInteractive = false;

  const finish = async (blocker?: string): Promise<CapabilityReport> => {
    if (blocker !== undefined && !notes.includes(`blocker:${blocker}`)) {
      notes.push(`blocker:${blocker}`);
    }
    const report: CapabilityReport = {
      agent: "codex",
      version,
      command: ["codex", ...firstArgs].join(" "),
      durationMs: Date.now() - startedAt,
      rawLogPath: predictedRawLogPath,
      notes,
      launch,
      streamOutput,
      sessionId,
      resume,
      interrupt: false,
      tokenUsage,
      nonInteractive,
      interactivePty: false,
      parallelThree: false
    };
    const fallbackRawOutput = blocker === undefined ? "" : `[agenttown] blocker:${blocker}\n`;
    const run = combineRuns(runs, fallbackRawOutput);
    const persistedReport: CapabilityReport = { ...report, rawLogPath: "raw.log" };
    const paths = await writeProbeArtifacts({
      rootDir: artifactRootDir,
      runId,
      run,
      events,
      report: persistedReport
    });
    report.rawLogPath = paths.rawLogPath;
    return report;
  };

  try {
    try {
      const versionRun = await execute({
        file: executable,
        args: ["--version"],
        cwd: process.cwd(),
        timeoutMs: options.timeoutMs
      });
      runs.push(versionRun);
      if (versionRun.timedOut) return await finish("timeout");
      if (versionRun.exitCode !== 0) return await finish("launch_failed");
      version = versionRun.rawOutput.trim() || "unknown";
    } catch (error) {
      const failure = knownLaunchFailure(error);
      if (failure === undefined) throw error;
      notes.push(`error_code:${failure.code}`);
      return await finish(failure.blocker);
    }

    temporaryRepository = await mkdtemp(join(tmpdir(), "agenttown-codex-probe-"));
    let gitRun: RunResult;
    try {
      gitRun = await execute({
        file: gitExecutable,
        args: ["init", "--quiet"],
        cwd: temporaryRepository,
        timeoutMs: options.timeoutMs
      });
      runs.push(gitRun);
    } catch (error) {
      const failure = knownLaunchFailure(error);
      if (failure === undefined) throw error;
      notes.push(`error_code:${failure.code}`);
      return await finish("temporary_repo_init_failed");
    }
    if (gitRun.timedOut || gitRun.exitCode !== 0) {
      return await finish("temporary_repo_init_failed");
    }

    const concreteFirstArgs = [
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--cd",
      temporaryRepository,
      FIRST_PROMPT
    ];
    let firstRun: RunResult;
    try {
      firstRun = await execute({
        file: executable,
        args: concreteFirstArgs,
        cwd: temporaryRepository,
        timeoutMs: options.timeoutMs
      });
      runs.push(firstRun);
      launch = true;
      nonInteractive = true;
    } catch (error) {
      const failure = knownLaunchFailure(error);
      if (failure === undefined) throw error;
      notes.push(`error_code:${failure.code}`);
      return await finish(failure.blocker);
    }

    const firstEvents = parseOutput(firstRun.rawOutput);
    events.push(...firstEvents);
    streamOutput = containsOutput(firstEvents, "AGENTTOWN_PROBE_OK");
    const session = firstEvents.find((event): event is Extract<ProbeEvent, { type: "session" }> => event.type === "session");
    sessionId = session !== undefined;
    tokenUsage = firstEvents.some((event) => event.type === "usage");

    if (firstRun.timedOut) return await finish("timeout");
    if (containsAuthenticationFailure(firstRun.rawOutput)) return await finish("authentication");
    if (firstEvents.some((event) => event.type === "parse_error")) return await finish("parse_failure");
    if (firstRun.exitCode !== 0) return await finish("launch_failed");
    if (!streamOutput) return await finish("probe_response_missing");
    if (session === undefined) return await finish("session_id_missing");

    let resumeRun: RunResult;
    try {
      resumeRun = await execute({
        file: executable,
        args: ["exec", "resume", session.sessionId, "--json", RESUME_PROMPT],
        cwd: temporaryRepository,
        timeoutMs: options.timeoutMs
      });
      runs.push(resumeRun);
    } catch (error) {
      const failure = knownLaunchFailure(error);
      if (failure === undefined) throw error;
      notes.push(`error_code:${failure.code}`);
      return await finish(failure.blocker);
    }
    const resumeEvents = parseOutput(resumeRun.rawOutput);
    events.push(...resumeEvents);
    if (resumeRun.timedOut) return await finish("timeout");
    if (containsAuthenticationFailure(resumeRun.rawOutput)) return await finish("authentication");
    resume = !resumeRun.timedOut
      && resumeRun.exitCode === 0
      && !resumeEvents.some((event) => event.type === "parse_error")
      && containsOutput(resumeEvents, "AGENTTOWN_RESUME_OK");
    if (!resume) return await finish("resume_failed");
    if (!tokenUsage) return await finish("token_usage_missing");
    return await finish();
  } finally {
    if (temporaryRepository !== undefined) {
      await rm(temporaryRepository, { recursive: true, force: true });
    }
  }
}
