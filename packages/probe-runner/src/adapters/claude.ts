import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { CapabilityReport, ProbeEvent } from "@agenttown/probe-contract";
import { writeProbeArtifacts } from "../artifacts.js";
import { runProcess as defaultRunProcess } from "../process.js";
import type { PtyOptions, RunResult } from "../pty.js";

const FIRST_PROMPT = "Reply with exactly AGENTTOWN_PROBE_OK";
const RESUME_PROMPT = "Reply with exactly AGENTTOWN_RESUME_OK";

export type ClaudeProcessRunner = (options: PtyOptions) => Promise<RunResult>;

export interface ProbeClaudeOptions {
  timeoutMs: number;
  artifactRootDir?: string;
  runId?: string;
  executable?: string;
  gitExecutable?: string;
  runProcess?: ClaudeProcessRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failureMessage(value: Record<string, unknown>): string | undefined {
  if (typeof value.message === "string") return value.message;
  if (typeof value.result === "string") return value.result;
  if (typeof value.error === "string") return value.error;
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return undefined;
}

export function parseClaudeLine(line: string): ProbeEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [{ type: "parse_error", raw: line, reason: "invalid_json" }];
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
  }

  if (value.type === "system" && value.subtype === "init") {
    return typeof value.session_id === "string"
      ? [{ type: "session", sessionId: value.session_id }]
      : [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
  }

  if (value.type === "assistant") {
    if (!isRecord(value.message) || !Array.isArray(value.message.content)) {
      return [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
    }
    return value.message.content.flatMap((content): ProbeEvent[] =>
      isRecord(content) && content.type === "text" && typeof content.text === "string"
        ? [{ type: "output", text: content.text }]
        : []
    );
  }

  if (value.type === "result" && value.subtype === "success" && value.is_error !== true) {
    if (!isRecord(value.usage)
      || typeof value.usage.input_tokens !== "number"
      || typeof value.usage.output_tokens !== "number") {
      return [{ type: "parse_error", raw: line, reason: "unknown_shape" }];
    }
    return typeof value.usage.cache_read_input_tokens === "number"
      ? [{
          type: "usage",
          inputTokens: value.usage.input_tokens,
          cachedInputTokens: value.usage.cache_read_input_tokens,
          outputTokens: value.usage.output_tokens
        }]
      : [{
          type: "usage",
          inputTokens: value.usage.input_tokens,
          outputTokens: value.usage.output_tokens
        }];
  }

  if (value.type === "error" || (value.type === "result" && (value.is_error === true || value.subtype !== "success"))) {
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
    .flatMap(parseClaudeLine);
}

function containsOutput(events: ProbeEvent[], text: string): boolean {
  return events.some((event) => event.type === "output" && event.text.includes(text));
}

function containsAuthenticationFailure(rawOutput: string): boolean {
  return /authentication|not logged in|unauthori[sz]ed|login required|please (?:run )?\/login|invalid (?:api )?key|\b401\b/iu.test(rawOutput);
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

function claudeInvocation(executable: string, args: string[]): Pick<PtyOptions, "file" | "args"> {
  return process.platform === "win32" && /\.ps1$/iu.test(executable)
    ? { file: "powershell.exe", args: ["-NoProfile", "-File", executable, ...args] }
    : { file: executable, args };
}

function resolveClaudeExecutable(configuredExecutable?: string): string {
  if (configuredExecutable !== undefined || process.platform !== "win32") {
    return configuredExecutable ?? "claude";
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const normalizedDirectory = directory.replace(/^"|"$/gu, "");
    if (normalizedDirectory.length === 0) continue;
    for (const filename of ["claude.exe", "claude.ps1"]) {
      const candidate = join(normalizedDirectory, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "claude";
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

function sanitizeText(text: string, temporaryRepository?: string): string {
  let sanitized = temporaryRepository === undefined
    ? text
    : text.replaceAll(temporaryRepository, "<temp-repo>");
  sanitized = sanitized
    .replace(/\b[A-Za-z]:\\Users\\[^\\\r\n]+(?:\\[^\s\r\n,;]*)?/giu, "[REDACTED_PATH]")
    .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\s\r\n,;]*)?/gu, "[REDACTED_PATH]");
  return sanitized;
}

function sanitizeJsonEvidence(value: unknown, temporaryRepository?: string, redactFailure = false): unknown {
  if (typeof value === "string") return sanitizeText(value, temporaryRepository);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonEvidence(item, temporaryRepository, redactFailure));
  }
  if (!isRecord(value)) return value;
  const failure = redactFailure
    || value.type === "error"
    || (value.type === "result" && (value.is_error === true || value.subtype !== "success"));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    failure && (key === "message" || key === "error" || key === "result")
      ? "[REDACTED]"
      : sanitizeJsonEvidence(item, temporaryRepository, failure)
  ]));
}

function sanitizeRawOutput(rawOutput: string, temporaryRepository?: string): string {
  return rawOutput.split(/(\r?\n)/u).map((part) => {
    if (/^\r?\n$/u.test(part) || part.length === 0) return part;
    try {
      return JSON.stringify(sanitizeJsonEvidence(JSON.parse(part), temporaryRepository));
    } catch {
      return sanitizeText(part, temporaryRepository);
    }
  }).join("");
}

function sanitizeEvents(events: ProbeEvent[], temporaryRepository?: string): ProbeEvent[] {
  return events.map((event) => {
    if (event.type === "output" && !event.text.includes("AGENTTOWN_")) {
      return { type: "output", text: "[REDACTED]" };
    }
    if (event.type === "parse_error") {
      return { ...event, raw: sanitizeText(event.raw, temporaryRepository) };
    }
    return event;
  });
}

function defaultRunId(): string {
  return `claude-${Date.now()}-${process.pid}`;
}

export async function probeClaude(options: ProbeClaudeOptions): Promise<CapabilityReport> {
  const startedAt = Date.now();
  const execute = options.runProcess ?? defaultRunProcess;
  const executable = resolveClaudeExecutable(options.executable);
  const gitExecutable = options.gitExecutable ?? "git";
  const artifactRootDir = options.artifactRootDir ?? resolve(process.cwd(), "artifacts", "feasibility");
  const runId = options.runId ?? defaultRunId();
  const firstArgs = [
    "-p", FIRST_PROMPT,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "plan"
  ];
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
      agent: "claude",
      version,
      command: ["claude", ...firstArgs].join(" "),
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
    const combined = combineRuns(runs, fallbackRawOutput);
    const run = {
      ...combined,
      rawOutput: sanitizeRawOutput(combined.rawOutput, temporaryRepository)
    };
    const persistedReport: CapabilityReport = { ...report, rawLogPath: "raw.log" };
    const paths = await writeProbeArtifacts({
      rootDir: artifactRootDir,
      runId,
      run,
      events: sanitizeEvents(events, temporaryRepository),
      report: persistedReport
    });
    report.rawLogPath = paths.rawLogPath;
    return report;
  };

  try {
    try {
      const command = claudeInvocation(executable, ["--version"]);
      const versionRun = await execute({
        ...command,
        cwd: process.cwd(),
        timeoutMs: options.timeoutMs
      });
      runs.push(versionRun);
      if (versionRun.timedOut) return await finish("timeout");
      if (versionRun.exitCode !== 0) return await finish("launch_failed");
      version = sanitizeText(versionRun.rawOutput.trim()) || "unknown";
    } catch (error) {
      const failure = knownLaunchFailure(error);
      if (failure === undefined) throw error;
      notes.push(`error_code:${failure.code}`);
      return await finish(failure.blocker);
    }

    temporaryRepository = await mkdtemp(join(tmpdir(), "agenttown-claude-probe-"));
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

    let firstRun: RunResult;
    try {
      const command = claudeInvocation(executable, firstArgs);
      firstRun = await execute({
        ...command,
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

    const resumeArgs = [
      "-p", RESUME_PROMPT,
      "--resume", session.sessionId,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "plan"
    ];
    let resumeRun: RunResult;
    try {
      const command = claudeInvocation(executable, resumeArgs);
      resumeRun = await execute({
        ...command,
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
    resume = resumeRun.exitCode === 0
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
