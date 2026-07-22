import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityReport } from "@agenttown/probe-contract";
import {
  probeRemainingAgentCapabilities,
  type RemainingCapabilitiesDependencies
} from "../src/real-capabilities.js";
import type { ProbeHandle, RunResult } from "../src/pty.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function artifactRoot(report: CapabilityReport): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agenttown-capabilities-test-"));
  temporaryDirectories.push(root);
  const directory = join(root, `${report.agent}-real`);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return root;
}

function report(agent: "codex" | "claude", overrides: Partial<CapabilityReport> = {}): CapabilityReport {
  return {
    agent,
    version: "fixture",
    command: `${agent} fixture`,
    durationMs: 1,
    rawLogPath: "raw.log",
    notes: [],
    launch: true,
    streamOutput: true,
    sessionId: true,
    resume: true,
    interrupt: false,
    tokenUsage: true,
    nonInteractive: true,
    interactivePty: false,
    parallelThree: false,
    ...overrides
  };
}

function result(rawOutput: string, exitCode = 0): RunResult {
  return {
    command: ["fixture"],
    startedAt: "2026-07-23T00:00:00.000Z",
    durationMs: 5,
    exitCode,
    rawOutput,
    timedOut: false
  };
}

function claudeOutput(sessionId: string, marker: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: marker }] } }),
    JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } })
  ].join("\n") + "\n";
}

function handle(pid: number, run: RunResult, calls: string[]): ProbeHandle {
  return {
    pid,
    completed: Promise.resolve(run),
    write() {},
    resize: (cols, rows) => calls.push(`resize:${pid}:${cols}x${rows}`),
    interrupt: () => calls.push(`interrupt:${pid}`),
    kill: () => calls.push(`kill:${pid}`),
    waitFor: async (predicate) => {
      if (!predicate(run.rawOutput)) throw new Error("fixture output did not match");
      return run.rawOutput;
    }
  };
}

function dependencies(outputs: Array<{
  sessionId: string;
  marker: string;
  exitCode?: number;
  rawOutput?: string;
}>, alivePids: number[] = []) {
  const calls: string[] = [];
  const livenessChecks = new Map<number, number>();
  let index = 0;
  const value: RemainingCapabilitiesDependencies = {
    initializeGit: async () => undefined,
    startPty: () => {
      const output = outputs[index++]!;
      return handle(700 + index, result(
        output.rawOutput ?? claudeOutput(output.sessionId, output.marker),
        output.exitCode
      ), calls);
    },
    isAlive: async (pid) => {
      const count = livenessChecks.get(pid) ?? 0;
      livenessChecks.set(pid, count + 1);
      return alivePids.includes(pid) || (pid === 701 && count === 0);
    }
  };
  return { calls, value };
}

describe("probeRemainingAgentCapabilities", () => {
  it("records a prerequisite blocker without starting Codex when launch already failed", async () => {
    const root = await artifactRoot(report("codex", {
      launch: false,
      streamOutput: false,
      sessionId: false,
      resume: false,
      tokenUsage: false,
      notes: ["error_code:EPERM", "blocker:launch_failed"]
    }));
    let starts = 0;

    const outcome = await probeRemainingAgentCapabilities("codex", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: {
        initializeGit: async () => undefined,
        startPty: () => { starts += 1; throw new Error("must not start"); },
        isAlive: async () => false
      }
    });

    expect(starts).toBe(0);
    expect(outcome).toMatchObject({
      attempted: false,
      interrupt: false,
      parallelThree: false,
      blockers: ["capability_prerequisite_launch_failed"]
    });
  });

  it("verifies Claude interrupt plus three independent first turns and atomically updates its report", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "interrupt-session", marker: "AGENTTOWN_INTERRUPT_PROBE" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome).toMatchObject({ attempted: true, interrupt: true, parallelThree: true, blockers: [] });
    expect(fixture.calls).toContain("interrupt:701");
    const persisted = JSON.parse(await readFile(join(root, "claude-real", "report.json"), "utf8")) as CapabilityReport;
    expect(persisted.interrupt).toBe(true);
    expect(persisted.parallelThree).toBe(true);
    expect(persisted.notes).toEqual([]);
    expect((await readdir(join(root, "claude-real"))).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("does not claim interrupt when the interrupted PID survives cleanup", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "interrupt-session", marker: "AGENTTOWN_INTERRUPT_PROBE" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ], [701]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 5,
      dependencies: fixture.value
    });

    expect(outcome.interrupt).toBe(false);
    expect(outcome.blockers).toContain("interrupt_orphan_process");
  });

  it("does not claim interrupt if the process exited before Ctrl+C was delivered", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "interrupt-session", marker: "AGENTTOWN_INTERRUPT_PROBE" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ]);
    fixture.value.isAlive = async () => false;

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome.interrupt).toBe(false);
    expect(outcome.blockers).toContain("interrupt_process_exited_before_signal");
  });

  it.each([
    {
      name: "duplicate session IDs",
      outputs: [
        { sessionId: "interrupt", marker: "AGENTTOWN_INTERRUPT_PROBE" },
        { sessionId: "duplicate", marker: "AGENTTOWN_PARALLEL_ONE" },
        { sessionId: "duplicate", marker: "AGENTTOWN_PARALLEL_TWO" },
        { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
      ],
      blocker: "parallel_duplicate_session_id"
    },
    {
      name: "partial failure",
      outputs: [
        { sessionId: "interrupt", marker: "AGENTTOWN_INTERRUPT_PROBE" },
        { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
        { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO", exitCode: 7 },
        { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
      ],
      blocker: "parallel_partial_failure:two:exit_7"
    }
  ])("records exact blockers for $name", async ({ outputs, blocker }) => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies(outputs);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome.parallelThree).toBe(false);
    expect(outcome.blockers).toContain(blocker);
  });

  it("preserves original failing PTY evidence in the local parallel log", async () => {
    const root = await artifactRoot(report("claude"));
    const rawFailure = `${claudeOutput("parallel-2", "AGENTTOWN_PARALLEL_TWO")}RAW_STDERR_MARKER\n`;
    const fixture = dependencies([
      { sessionId: "interrupt", marker: "AGENTTOWN_INTERRUPT_PROBE" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO", exitCode: 7, rawOutput: rawFailure },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome.blockers).toContain("parallel_partial_failure:two:exit_7");
    const localLog = await readFile(join(root, "claude-capabilities", "parallel", "two.log"), "utf8");
    expect(localLog).toBe(rawFailure);
    expect(localLog).toContain("RAW_STDERR_MARKER");
  });

  it("extracts sessions and markers from ANSI-prefixed terminal-wrapped JSON", async () => {
    const root = await artifactRoot(report("claude"));
    const wrapped = (sessionId: string, marker: string) => [
      "\u001b[?9001h\u001b[2J",
      `{"type":"system",\r\n"subtype":"init",\r\n"session_id":"${sessionId}"}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"${marker.slice(0, 12)}\r\n${marker.slice(12)}"}]}}`,
      '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}'
    ].join("\r\n") + "\r\n";
    const fixture = dependencies([
      { sessionId: "interrupt-wrapped", marker: "AGENTTOWN_INTERRUPT_PROBE", rawOutput: wrapped("interrupt-wrapped", "AGENTTOWN_INTERRUPT_PROBE") },
      { sessionId: "parallel-wrapped-1", marker: "AGENTTOWN_PARALLEL_ONE", rawOutput: wrapped("parallel-wrapped-1", "AGENTTOWN_PARALLEL_ONE") },
      { sessionId: "parallel-wrapped-2", marker: "AGENTTOWN_PARALLEL_TWO", rawOutput: wrapped("parallel-wrapped-2", "AGENTTOWN_PARALLEL_TWO") },
      { sessionId: "parallel-wrapped-3", marker: "AGENTTOWN_PARALLEL_THREE", rawOutput: wrapped("parallel-wrapped-3", "AGENTTOWN_PARALLEL_THREE") }
    ]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome).toMatchObject({ interrupt: true, parallelThree: true, blockers: [] });
    expect(fixture.calls.filter((call) => call.startsWith("resize:"))).toEqual([
      "resize:701:240x60",
      "resize:702:240x60",
      "resize:703:240x60",
      "resize:704:240x60"
    ]);
  });
});
