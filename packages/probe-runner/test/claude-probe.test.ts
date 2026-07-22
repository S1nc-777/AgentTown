import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeClaude, type ClaudeProcessRunner } from "../src/adapters/claude.js";
import type { PtyOptions, RunResult } from "../src/pty.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function result(rawOutput: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    command: ["fixture"],
    startedAt: "2026-07-21T00:00:00.000Z",
    durationMs: 10,
    exitCode: 0,
    rawOutput,
    timedOut: false,
    ...overrides
  };
}

async function artifactRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agenttown-claude-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

const firstSuccess = [
  '{"type":"system","subtype":"init","session_id":"session-fixture"}',
  '{"type":"stream_event","event":{"type":"content_block_start"}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"AGENTTOWN_PROBE_OK"}]}}',
  '{"type":"result","subtype":"success","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":4}}'
].join("\n") + "\n";

const resumeSuccess = [
  '{"type":"system","subtype":"init","session_id":"session-fixture"}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"AGENTTOWN_RESUME_OK"}]}}',
  '{"type":"result","subtype":"success","usage":{"input_tokens":2,"output_tokens":2}}'
].join("\n") + "\n";

function successfulRunner(calls: PtyOptions[]): ClaudeProcessRunner {
  return async (options) => {
    calls.push(options);
    if (options.file === "git") {
      await mkdir(join(options.cwd, ".git"));
      return result("");
    }
    if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
    if (options.args.includes("--resume")) return result(resumeSuccess);
    return result(firstSuccess);
  };
}

function stageOf(options: PtyOptions): "version" | "git" | "first" | "resume" {
  if (options.args.includes("--version")) return "version";
  if (options.file === "git") return "git";
  return options.args.includes("--resume") ? "resume" : "first";
}

describe("probeClaude", () => {
  it("uses permission-mode plan, resumes by session ID, and records raw plus normalized evidence", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "claude-offline-success",
      executable: "claude",
      runProcess: successfulRunner(calls)
    });

    expect(calls.map(({ file, args }) => [file, ...args])).toEqual([
      ["claude", "--version"],
      ["git", "init", "--quiet"],
      ["claude", "-p", "Reply with exactly AGENTTOWN_PROBE_OK", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"],
      ["claude", "-p", "Reply with exactly AGENTTOWN_RESUME_OK", "--resume", "session-fixture", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"]
    ]);
    expect(calls[1]?.cwd).toBe(calls[2]?.cwd);
    expect(calls[2]?.cwd).toBe(calls[3]?.cwd);
    expect(calls[2]?.cwd).toMatch(/agenttown-claude-probe-/u);
    expect(calls.every(({ timeoutMs }) => timeoutMs === 1_000)).toBe(true);
    expect(calls.flatMap(({ args }) => args)).not.toContain("--dangerously-skip-permissions");
    expect(report).toMatchObject({
      agent: "claude",
      version: "claude-code 9.9.9",
      launch: true,
      streamOutput: true,
      sessionId: true,
      resume: true,
      tokenUsage: true,
      nonInteractive: true,
      interrupt: false,
      interactivePty: false,
      parallelThree: false,
      notes: []
    });

    const raw = await readFile(report.rawLogPath, "utf8");
    const events = await readFile(join(rootDir, "claude-offline-success", "events.jsonl"), "utf8");
    const persistedReport = JSON.parse(
      await readFile(join(rootDir, "claude-offline-success", "report.json"), "utf8")
    ) as { rawLogPath: string };
    expect(raw).toContain('"type":"stream_event"');
    expect(raw).toContain("AGENTTOWN_RESUME_OK");
    expect(events).toContain('"type":"session"');
    expect(events).toContain('"type":"usage"');
    expect(events).not.toContain('"type":"stream_event"');
    expect(persistedReport.rawLogPath).toBe("raw.log");
    await expect(access(calls[2]!.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists only the logical Claude command and never the configured absolute path", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const executable = String.raw`C:\Users\private-user\bin\claude-private.cmd`;
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "claude-portable-command",
      executable,
      runProcess: successfulRunner(calls)
    });

    expect(calls[0]?.file).toBe(executable);
    expect(report.command).toMatch(/^claude /u);
    expect(report.command).not.toContain("--dangerously-skip-permissions");
    const persisted = await readFile(join(rootDir, "claude-portable-command", "report.json"), "utf8");
    expect(persisted).not.toContain("private-user");
    expect(persisted).not.toContain("claude-private.cmd");
    expect(persisted).not.toContain("C:\\\\Users");
  });

  it.runIf(process.platform === "win32")("launches an explicit PowerShell shim without persisting its private path", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const executable = String.raw`C:\Users\private-user\bin\claude.ps1`;
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "claude-powershell-shim",
      executable,
      runProcess: successfulRunner(calls)
    });

    expect(calls[0]).toMatchObject({
      file: "powershell.exe",
      args: ["-NoProfile", "-File", executable, "--version"]
    });
    expect(calls[2]?.file).toBe("powershell.exe");
    expect(calls[2]?.args.slice(0, 3)).toEqual(["-NoProfile", "-File", executable]);
    expect(report.resume).toBe(true);
    const persisted = await readFile(join(rootDir, "claude-powershell-shim", "report.json"), "utf8");
    expect(persisted).not.toContain("private-user");
    expect(persisted).not.toContain("claude.ps1");
  });

  it.runIf(process.platform === "win32")("resolves the default PowerShell shim from PATH for Node-safe launching", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const shimDirectory = await mkdtemp(join(tmpdir(), "agenttown-claude-shim-"));
    temporaryDirectories.push(shimDirectory);
    const shim = join(shimDirectory, "claude.ps1");
    await writeFile(shim, "# fixture only\n", "utf8");
    vi.stubEnv("PATH", shimDirectory);

    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "claude-default-powershell-shim",
      runProcess: successfulRunner(calls)
    });

    expect(calls[0]).toMatchObject({
      file: "powershell.exe",
      args: ["-NoProfile", "-File", shim, "--version"]
    });
    expect(report.resume).toBe(true);
    const persisted = await readFile(join(rootDir, "claude-default-powershell-shim", "report.json"), "utf8");
    expect(persisted).not.toContain(shimDirectory);
    expect(persisted).not.toContain("claude.ps1");
  });

  it.each(["version", "git", "first", "resume"] as const)(
    "propagates unknown exceptions from the %s stage and cleans the temp repository",
    async (failureStage) => {
      const calls: PtyOptions[] = [];
      const rootDir = await artifactRoot();
      const baseRunner = successfulRunner(calls);
      const run: ClaudeProcessRunner = async (options) => {
        if (stageOf(options) === failureStage) throw new TypeError(`programmer error at ${failureStage}`);
        return await baseRunner(options);
      };

      await expect(probeClaude({
        timeoutMs: 1_000,
        artifactRootDir: rootDir,
        runId: `claude-programmer-error-${failureStage}`,
        runProcess: run
      })).rejects.toThrow(new TypeError(`programmer error at ${failureStage}`));

      const repositoryCall = calls.find((call) => call.cwd.includes("agenttown-claude-probe-"));
      if (repositoryCall !== undefined) {
        await expect(access(repositoryCall.cwd)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  );

  it.each(["ENOENT", "EACCES", "EPERM"] as const)(
    "classifies Git initialization %s as a temporary-repository blocker without persisting the error message",
    async (code) => {
      const rootDir = await artifactRoot();
      const report = await probeClaude({
        timeoutMs: 1_000,
        artifactRootDir: rootDir,
        runId: `claude-git-${code.toLowerCase()}`,
        runProcess: async (options) => {
          if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
          if (options.file === "git") {
            throw Object.assign(new Error("sensitive Git executable path"), { code });
          }
          throw new TypeError("Claude execution must not start after Git initialization fails");
        }
      });

      expect(report.notes).toContain(`error_code:${code}`);
      expect(report.notes).toContain("blocker:temporary_repo_init_failed");
      expect(report.notes).not.toContain("blocker:executable_not_found");
      expect(report.notes).not.toContain("blocker:launch_failed");
      const persisted = await readFile(join(rootDir, `claude-git-${code.toLowerCase()}`, "report.json"), "utf8");
      expect(persisted).not.toContain("sensitive Git executable path");
    }
  );

  it("maps resume authentication before generic resume failure", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const baseRunner = successfulRunner(calls);
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "claude-resume-authentication",
      runProcess: async (options) => options.args.includes("--resume")
        ? result('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"authentication required"}\n', { exitCode: 1 })
        : await baseRunner(options)
    });

    expect(report.notes).toContain("blocker:authentication");
    expect(report.notes).not.toContain("blocker:resume_failed");
  });

  it.each([
    {
      name: "missing resume session",
      resumeOutput: resumeSuccess.split(/\r?\n/u).filter((line) => !line.includes('"type":"system"')).join("\n")
    },
    {
      name: "mismatched resume session",
      resumeOutput: resumeSuccess.replace("session-fixture", "different-session")
    },
    {
      name: "resume error",
      resumeOutput: [
        '{"type":"system","subtype":"init","session_id":"session-fixture"}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"AGENTTOWN_RESUME_OK"}]}}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"AGENTTOWN_RESUME_OK"}'
      ].join("\n")
    }
  ])("rejects $name even when the resume prompt succeeds", async ({ resumeOutput }) => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const baseRunner = successfulRunner(calls);
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: `claude-resume-session-${calls.length}-${resumeOutput.length}`,
      executable: "claude",
      runProcess: async (options) => options.args.includes("--resume")
        ? result(resumeOutput)
        : await baseRunner(options)
    });

    expect(report.resume).toBe(false);
    expect(report.notes).toContain("blocker:resume_failed");
  });

  it("redacts sensitive keys in unknown valid raw JSON while preserving structure and usage numbers", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const runId = "claude-unknown-json-secrets";
    const metadata = {
      type: "metadata",
      api_key: "synthetic-secret",
      nested: { access_token: "nested-synthetic-secret" },
      usage: { inputTokens: 10, outputTokens: 5 }
    };
    const baseRunner = successfulRunner(calls);
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId,
      executable: "claude",
      runProcess: async (options) => stageOf(options) === "first"
        ? result(`${JSON.stringify(metadata)}\n${firstSuccess}`)
        : await baseRunner(options)
    });

    expect(report.notes).toEqual([]);
    const raw = await readFile(report.rawLogPath, "utf8");
    const events = await readFile(join(rootDir, runId, "events.jsonl"), "utf8");
    const persistedMetadata = raw.split(/\r?\n/u)
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; } })
      .find((value) => value?.type === "metadata");
    expect(persistedMetadata).toEqual({
      type: "metadata",
      api_key: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    expect(`${raw}${events}`).not.toContain("synthetic-secret");
    expect(events).not.toContain('"type":"metadata"');
  });

  it("sanitizes malformed known JSON before parse-error normalization and persistence", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const runId = "claude-malformed-json-secrets";
    const malformed = {
      type: "system",
      subtype: "init",
      api_key: "synthetic-secret",
      nested: { credentials: { access_token: "nested-synthetic-secret" } },
      usage: { inputTokens: 10, outputTokens: 5 }
    };
    const invalidJson = '{"type":"system","api_key":"truncated-synthetic-secret"';
    const baseRunner = successfulRunner(calls);
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId,
      executable: "claude",
      runProcess: async (options) => stageOf(options) === "first"
        ? result(`${JSON.stringify(malformed)}\n${invalidJson}\n${firstSuccess}`)
        : await baseRunner(options)
    });

    expect(report.notes).toContain("blocker:parse_failure");
    const raw = await readFile(report.rawLogPath, "utf8");
    const eventLines = (await readFile(join(rootDir, runId, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    const parseErrors = eventLines.filter((event) => event.type === "parse_error") as Array<{ raw: string }>;
    expect(parseErrors).toHaveLength(2);
    const structuredParseError = parseErrors.find(({ raw: parseErrorRaw }) => {
      try { return (JSON.parse(parseErrorRaw) as { subtype?: string }).subtype === "init"; } catch { return false; }
    });
    expect(structuredParseError).toBeDefined();
    expect(JSON.parse(structuredParseError!.raw)).toEqual({
      type: "system",
      subtype: "init",
      api_key: "[REDACTED]",
      nested: { credentials: "[REDACTED]" },
      usage: { inputTokens: 10, outputTokens: 5 }
    });
    expect(`${raw}${JSON.stringify(eventLines)}`).not.toContain("synthetic-secret");
    expect(parseErrors.map(({ raw: parseErrorRaw }) => parseErrorRaw).join("\n")).not.toContain("truncated-synthetic-secret");
  });

  it("redacts Claude error messages and private paths while preserving structural raw evidence", async () => {
    const rootDir = await artifactRoot();
    const runId = "claude-redacted-error";
    const sensitive = String.raw`authentication required at C:\Users\private-user\.claude`;
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId,
      runProcess: async (options) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result(`${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: sensitive
        })}\n`, { exitCode: 1 });
      }
    });

    expect(report.notes).toContain("blocker:authentication");
    const raw = await readFile(report.rawLogPath, "utf8");
    const events = await readFile(join(rootDir, runId, "events.jsonl"), "utf8");
    expect(raw).toContain('"subtype":"error_during_execution"');
    expect(raw).not.toContain("private-user");
    expect(raw).not.toContain("authentication required");
    expect(events).not.toContain("private-user");
    expect(events).not.toContain("authentication required");
  });

  it.each([
    {
      name: "missing executable",
      expected: "blocker:executable_not_found",
      expectedErrorCode: "ENOENT",
      run: async (_options: PtyOptions) => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
    },
    {
      name: "launch access denied",
      expected: "blocker:launch_failed",
      expectedErrorCode: "EACCES",
      run: async (_options: PtyOptions) => { throw Object.assign(new Error("sensitive path"), { code: "EACCES" }); }
    },
    {
      name: "launch operation not permitted",
      expected: "blocker:launch_failed",
      expectedErrorCode: "EPERM",
      run: async (_options: PtyOptions) => { throw Object.assign(new Error("sensitive path"), { code: "EPERM" }); }
    },
    {
      name: "authentication failure",
      expected: "blocker:authentication",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"login required"}\n', { exitCode: 1 });
      }
    },
    {
      name: "timeout",
      expected: "blocker:timeout",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result("", { exitCode: -1, timedOut: true });
      }
    },
    {
      name: "parse failure",
      expected: "blocker:parse_failure",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result("not-json\n");
      }
    },
    {
      name: "missing probe response",
      expected: "blocker:probe_response_missing",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result(firstSuccess.replace("AGENTTOWN_PROBE_OK", "WRONG_RESPONSE"));
      }
    },
    {
      name: "missing session ID",
      expected: "blocker:session_id_missing",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        return result(firstSuccess.split(/\r?\n/u).filter((line) => !line.includes('"type":"system"')).join("\n"));
      }
    },
    {
      name: "missing token usage",
      expected: "blocker:token_usage_missing",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        if (options.args.includes("--resume")) return result(resumeSuccess);
        return result(firstSuccess.split(/\r?\n/u).filter((line) => !line.includes('"type":"result"')).join("\n"));
      }
    },
    {
      name: "resume failure",
      expected: "blocker:resume_failed",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args.includes("--version")) return result("claude-code 9.9.9\n");
        if (options.args.includes("--resume")) {
          return result('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"resume unavailable"}\n', { exitCode: 1 });
        }
        return result(firstSuccess);
      }
    }
  ])("returns a complete sanitized report for $name", async ({ run, expected, expectedErrorCode }) => {
    const rootDir = await artifactRoot();
    const runId = `claude-${expected.slice("blocker:".length).replaceAll("_", "-")}`;
    const report = await probeClaude({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId,
      runProcess: run
    });

    expect(report.notes).toContain(expected);
    if (expectedErrorCode !== undefined) expect(report.notes).toContain(`error_code:${expectedErrorCode}`);
    expect(report.resume).toBe(expected === "blocker:token_usage_missing");
    expect(report.rawLogPath).toMatch(/raw\.log$/u);
    const raw = await readFile(report.rawLogPath, "utf8");
    const persisted = await readFile(join(rootDir, runId, "report.json"), "utf8");
    expect(raw).toBeTypeOf("string");
    expect(persisted).not.toContain("sensitive path");
    expect(persisted).not.toContain("private-user");
  });
});
