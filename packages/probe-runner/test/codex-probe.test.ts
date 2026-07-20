import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeCodex, type ProcessRunner } from "../src/adapters/codex.js";
import type { PtyOptions, RunResult } from "../src/pty.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function result(rawOutput: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    command: ["fixture"],
    startedAt: "2026-07-20T00:00:00.000Z",
    durationMs: 10,
    exitCode: 0,
    rawOutput,
    timedOut: false,
    ...overrides
  };
}

async function artifactRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agenttown-codex-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function successfulRunner(calls: PtyOptions[]): ProcessRunner {
  return async (options) => {
    calls.push(options);
    if (options.file === "git") {
      await mkdir(join(options.cwd, ".git"));
      return result("");
    }
    if (options.args[0] === "--version") return result("codex-cli 9.9.9\n");
    if (options.args[1] === "resume") {
      return result('{"type":"item.completed","item":{"type":"agent_message","text":"AGENTTOWN_RESUME_OK"}}\n');
    }
    return result([
      '{"type":"thread.started","thread_id":"session-fixture"}',
      '{"type":"item.started","item":{"type":"command_execution"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"AGENTTOWN_PROBE_OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":3,"output_tokens":4}}'
    ].join("\n") + "\n");
  };
}

describe("probeCodex", () => {
  it("uses a temporary read-only Git probe, resumes the session, and records raw plus normalized evidence", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const report = await probeCodex({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "codex-offline-success",
      runProcess: successfulRunner(calls)
    });

    expect(calls.map(({ file, args }) => [file, ...args])).toEqual([
      ["codex", "--version"],
      ["git", "init", "--quiet"],
      ["codex", "exec", "--json", "--sandbox", "read-only", "--cd", calls[2]?.cwd, "Reply with exactly AGENTTOWN_PROBE_OK"],
      ["codex", "exec", "resume", "session-fixture", "--json", "Reply with exactly AGENTTOWN_RESUME_OK"]
    ]);
    expect(calls[1]?.cwd).toBe(calls[2]?.cwd);
    expect(calls[2]?.cwd).toBe(calls[3]?.cwd);
    expect(calls[2]?.cwd).toMatch(/agenttown-codex-probe-/u);
    expect(calls.every(({ timeoutMs }) => timeoutMs === 1_000)).toBe(true);
    expect(report).toMatchObject({
      agent: "codex",
      version: "codex-cli 9.9.9",
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
    const events = await readFile(join(rootDir, "codex-offline-success", "events.jsonl"), "utf8");
    const persistedReport = JSON.parse(
      await readFile(join(rootDir, "codex-offline-success", "report.json"), "utf8")
    ) as { rawLogPath: string };
    expect(raw).toContain('"type":"item.started"');
    expect(raw).toContain("AGENTTOWN_RESUME_OK");
    expect(events).toContain('"type":"session"');
    expect(events).toContain('"type":"usage"');
    expect(events).not.toContain('"type":"item.started"');
    expect(persistedReport.rawLogPath).toBe("raw.log");
    await expect(access(calls[2]!.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never persists a configured absolute Codex executable path", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const executable = String.raw`C:\Users\private-user\bin\codex-private.cmd`;
    const report = await probeCodex({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "codex-portable-command",
      executable,
      runProcess: successfulRunner(calls)
    });

    expect(calls[0]?.file).toBe(executable);
    expect(report.command).toMatch(/^codex /u);
    const persisted = await readFile(join(rootDir, "codex-portable-command", "report.json"), "utf8");
    expect(persisted).not.toContain("private-user");
    expect(persisted).not.toContain("codex-private.cmd");
    expect(persisted).not.toContain("C:\\\\Users");
  });

  it.each(["version", "git", "first", "resume"] as const)(
    "propagates programmer errors from the %s stage",
    async (failureStage) => {
      const calls: PtyOptions[] = [];
      const rootDir = await artifactRoot();
      const baseRunner = successfulRunner(calls);
      const run: ProcessRunner = async (options) => {
        const stage = options.args[0] === "--version"
          ? "version"
          : options.file === "git"
            ? "git"
            : options.args[1] === "resume"
              ? "resume"
              : "first";
        if (stage === failureStage) throw new TypeError(`programmer error at ${stage}`);
        return await baseRunner(options);
      };

      await expect(probeCodex({
        timeoutMs: 1_000,
        artifactRootDir: rootDir,
        runId: `codex-programmer-error-${failureStage}`,
        runProcess: run
      })).rejects.toThrow(new TypeError(`programmer error at ${failureStage}`));

      const repositoryCall = calls.find((call) => call.cwd.includes("agenttown-codex-probe-"));
      if (repositoryCall !== undefined) {
        await expect(access(repositoryCall.cwd)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  );

  it("maps authentication output from resume before generic resume failure", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const baseRunner = successfulRunner(calls);
    const report = await probeCodex({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "codex-resume-authentication",
      runProcess: async (options) => options.args[1] === "resume"
        ? result('{"type":"error","message":"authentication required"}\n', { exitCode: 1 })
        : await baseRunner(options)
    });

    expect(report.notes).toContain("blocker:authentication");
    expect(report.notes).not.toContain("blocker:resume_failed");
  });

  it("removes the temporary repository after a blocker report", async () => {
    const calls: PtyOptions[] = [];
    const rootDir = await artifactRoot();
    const baseRunner = successfulRunner(calls);
    const report = await probeCodex({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: "codex-cleanup-blocker",
      runProcess: async (options) => options.args[0] === "exec"
        ? result('{"type":"error","message":"authentication required"}\n', { exitCode: 1 })
        : await baseRunner(options)
    });

    expect(report.notes).toContain("blocker:authentication");
    const repositoryCall = calls.find((call) => call.cwd.includes("agenttown-codex-probe-"));
    expect(repositoryCall).toBeDefined();
    await expect(access(repositoryCall!.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(rootDir, "codex-cleanup-blocker", "report.json"))).resolves.toBeUndefined();
  });

  it.each([
    {
      name: "missing executable",
      expected: "blocker:executable_not_found",
      expectedErrorCode: "ENOENT",
      run: async (_options: PtyOptions) => {
        const error = Object.assign(new Error("missing"), { code: "ENOENT" });
        throw error;
      }
    },
    {
      name: "authentication failure",
      expected: "blocker:authentication",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args[0] === "--version") return result("codex-cli 9.9.9\n");
        return result('{"type":"error","message":"authentication required"}\n', { exitCode: 1 });
      }
    },
    {
      name: "launch access denied",
      expected: "blocker:launch_failed",
      expectedErrorCode: "EACCES",
      run: async (_options: PtyOptions) => {
        throw Object.assign(new Error("sensitive absolute path must not persist"), { code: "EACCES" });
      }
    },
    {
      name: "launch operation not permitted",
      expected: "blocker:launch_failed",
      expectedErrorCode: "EPERM",
      run: async (_options: PtyOptions) => {
        throw Object.assign(new Error("sensitive absolute path must not persist"), { code: "EPERM" });
      }
    },
    {
      name: "timeout",
      expected: "blocker:timeout",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args[0] === "--version") return result("codex-cli 9.9.9\n");
        return result("", { exitCode: -1, timedOut: true });
      }
    },
    {
      name: "parse failure",
      expected: "blocker:parse_failure",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args[0] === "--version") return result("codex-cli 9.9.9\n");
        return result("not-json\n");
      }
    },
    {
      name: "resume failure",
      expected: "blocker:resume_failed",
      expectedErrorCode: undefined,
      run: async (options: PtyOptions) => {
        if (options.file === "git") return result("");
        if (options.args[0] === "--version") return result("codex-cli 9.9.9\n");
        if (options.args[1] === "resume") return result('{"type":"error","message":"resume unavailable"}\n', { exitCode: 1 });
        return result([
          '{"type":"thread.started","thread_id":"session-fixture"}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"AGENTTOWN_PROBE_OK"}}',
          '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
        ].join("\n") + "\n");
      }
    }
  ])("returns a complete report and sanitized evidence for $name", async ({ run, expected, expectedErrorCode }) => {
    const rootDir = await artifactRoot();
    const report = await probeCodex({
      timeoutMs: 1_000,
      artifactRootDir: rootDir,
      runId: `codex-${expected.slice("blocker:".length).replaceAll("_", "-")}`,
      runProcess: run
    });

    expect(report.notes).toContain(expected);
    if (expectedErrorCode !== undefined) {
      expect(report.notes).toContain(`error_code:${expectedErrorCode}`);
    }
    expect(report.resume).toBe(false);
    expect(report.rawLogPath).toMatch(/raw\.log$/u);
    await expect(readFile(report.rawLogPath, "utf8")).resolves.toBeTypeOf("string");
  });
});
