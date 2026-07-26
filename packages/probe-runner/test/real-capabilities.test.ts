import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityReport } from "@agenttown/probe-contract";
import {
  probeRemainingAgentCapabilities,
  type RemainingCapabilitiesDependencies
} from "../src/real-capabilities.js";
import type { ProbeHandle, PtyOptions, RunResult } from "../src/pty.js";

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

function result(rawOutput: string, exitCode = 0, timedOut = false): RunResult {
  return {
    command: ["fixture"],
    startedAt: "2026-07-23T00:00:00.000Z",
    durationMs: 5,
    exitCode,
    rawOutput,
    timedOut
  };
}

function claudeOutput(sessionId: string, marker: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: marker }] } }),
    JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } })
  ].join("\n") + "\n";
}

function codexOutput(sessionId: string, marker: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: sessionId }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: marker } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })
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
  timedOut?: boolean;
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
        output.exitCode,
        output.timedOut
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

  it("attempts the remaining Claude checks when launch passed even if resume failed", async () => {
    const root = await artifactRoot(report("claude", { resume: false, sessionId: false }));
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

    expect(outcome).toMatchObject({ attempted: true, interrupt: true, parallelThree: true });
    expect(fixture.calls.filter((call) => call.startsWith("resize:"))).toHaveLength(4);
  });

  it("runs Codex capability checks through read-only exec JSON and parses Codex events", async () => {
    const root = await artifactRoot(report("codex"));
    const outputs = [
      codexOutput("interrupt-codex", "AGENTTOWN_INTERRUPT_PROBE"),
      codexOutput("parallel-codex-1", "AGENTTOWN_PARALLEL_ONE"),
      codexOutput("parallel-codex-2", "AGENTTOWN_PARALLEL_TWO"),
      codexOutput("parallel-codex-3", "AGENTTOWN_PARALLEL_THREE")
    ];
    const launches: PtyOptions[] = [];
    const checks = new Map<number, number>();
    const dependencies: RemainingCapabilitiesDependencies = {
      initializeGit: async () => undefined,
      startPty: (options) => {
        launches.push(options);
        const index = launches.length - 1;
        return handle(801 + index, result(outputs[index]!), []);
      },
      isAlive: async (pid) => {
        const count = checks.get(pid) ?? 0;
        checks.set(pid, count + 1);
        return pid === 801 && count === 0;
      }
    };

    const outcome = await probeRemainingAgentCapabilities("codex", {
      artifactRootDir: root,
      timeoutMs: 100,
      executable: "codex-fixture",
      dependencies
    });

    expect(outcome).toMatchObject({ attempted: true, interrupt: true, parallelThree: true, blockers: [] });
    expect(launches).toHaveLength(4);
    for (const launch of launches) {
      expect(launch.file).toBe("codex-fixture");
      expect(launch.args.slice(0, 6)).toEqual(["exec", "--json", "--sandbox", "read-only", "--cd", launch.cwd]);
    }
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

  it("does not claim interrupt when Ctrl+C is ignored and the PTY timeout performs the final kill", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "interrupt-session", marker: "AGENTTOWN_INTERRUPT_PROBE", timedOut: true },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 100,
      dependencies: fixture.value
    });

    expect(outcome.interrupt).toBe(false);
    expect(outcome.blockers).toContain("interrupt_timeout");
    expect(outcome.orphanPids).toEqual([]);
    expect(fixture.calls).toContain("interrupt:701");
    expect(fixture.calls).toContain("kill:701");
    const log = await readFile(join(root, "claude-capabilities", "interrupt.log"), "utf8");
    expect(log).toContain("timed_out:true");
    expect(log).toContain("process_dead:true");
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

  it("reports an orphan when an apparent early exit is followed by a live PID", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "interrupt-session", marker: "AGENTTOWN_INTERRUPT_PROBE" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ]);
    let checks = 0;
    fixture.value.isAlive = async (pid) => pid === 701 && checks++ > 0;

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 5,
      dependencies: fixture.value
    });

    expect(outcome.blockers).toContain("interrupt_orphan_process");
    expect(outcome.orphanPids).toContain(701);
    expect(fixture.calls).toContain("kill:701");
    const log = await readFile(join(root, "claude-capabilities", "interrupt.log"), "utf8");
    expect(log).toContain("session_observed:true");
    expect(log).toContain("process_dead:false");
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
      `{"type":"system"\u001b[?25l,\r\n"subtype":"init",\r\n"session_id":"${sessionId}"}`,
      `{"type":"assistant"\u001b[?25h,\r\n"message":{"content":[{"type":"text","text":"${marker}"}]}}`,
      '{"type":"result",\r\n"subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}'
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

  it("rejects plain stderr and model text that merely contain session and marker strings", async () => {
    const root = await artifactRoot(report("claude"));
    const fakeEvidence = (sessionId: string, marker: string) => [
      `stderr says {"session_id":"${sessionId}"}`,
      marker,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ordinary output" }] } })
    ].join("\n");
    const fixture = dependencies([
      { sessionId: "fake-interrupt", marker: "AGENTTOWN_INTERRUPT_PROBE", rawOutput: fakeEvidence("fake-interrupt", "AGENTTOWN_INTERRUPT_PROBE") },
      { sessionId: "fake-1", marker: "AGENTTOWN_PARALLEL_ONE", rawOutput: fakeEvidence("fake-1", "AGENTTOWN_PARALLEL_ONE") },
      { sessionId: "fake-2", marker: "AGENTTOWN_PARALLEL_TWO", rawOutput: fakeEvidence("fake-2", "AGENTTOWN_PARALLEL_TWO") },
      { sessionId: "fake-3", marker: "AGENTTOWN_PARALLEL_THREE", rawOutput: fakeEvidence("fake-3", "AGENTTOWN_PARALLEL_THREE") }
    ]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 5,
      dependencies: fixture.value
    });

    expect(outcome.interrupt).toBe(false);
    expect(outcome.parallelThree).toBe(false);
    expect(outcome.blockers).toContain("interrupt_session_not_observed");
  });

  it.each(["claude", "codex"] as const)(
    "rejects complete valid %s events embedded in prose or followed by terminal text",
    async (agent) => {
      const root = await artifactRoot(report(agent));
      const encoded = agent === "claude" ? claudeOutput : codexOutput;
      const outputs = [
        `stderr prefix ${encoded("embedded-interrupt", "AGENTTOWN_INTERRUPT_PROBE")}`,
        `${encoded("embedded-one", "AGENTTOWN_PARALLEL_ONE").trimEnd()} trailing text\n`,
        `model prose ${encoded("embedded-two", "AGENTTOWN_PARALLEL_TWO")}`,
        `${encoded("embedded-three", "AGENTTOWN_PARALLEL_THREE").trimEnd()} trailing text\n`
      ];
      let index = 0;
      const checks = new Map<number, number>();
      const fixture: RemainingCapabilitiesDependencies = {
        initializeGit: async () => undefined,
        startPty: () => {
          const current = index++;
          return handle(901 + current, result(outputs[current]!), []);
        },
        isAlive: async (pid) => {
          const count = checks.get(pid) ?? 0;
          checks.set(pid, count + 1);
          return pid === 901 && count === 0;
        }
      };

      const outcome = await probeRemainingAgentCapabilities(agent, {
        artifactRootDir: root,
        timeoutMs: 5,
        dependencies: fixture
      });

      expect(outcome.interrupt).toBe(false);
      expect(outcome.parallelThree).toBe(false);
      expect(outcome.blockers).toContain("interrupt_session_not_observed");
    }
  );

  it("reports an orphan when the session-timeout cleanup leaves the PID alive", async () => {
    const root = await artifactRoot(report("claude"));
    const fixture = dependencies([
      { sessionId: "missing", marker: "missing", rawOutput: "no structured session\n" },
      { sessionId: "parallel-1", marker: "AGENTTOWN_PARALLEL_ONE" },
      { sessionId: "parallel-2", marker: "AGENTTOWN_PARALLEL_TWO" },
      { sessionId: "parallel-3", marker: "AGENTTOWN_PARALLEL_THREE" }
    ], [701]);

    const outcome = await probeRemainingAgentCapabilities("claude", {
      artifactRootDir: root,
      timeoutMs: 5,
      dependencies: fixture.value
    });

    expect(outcome.blockers).toContain("interrupt_orphan_process");
    expect(outcome.orphanPids).toContain(701);
    const log = await readFile(join(root, "claude-capabilities", "interrupt.log"), "utf8");
    expect(log).toContain("no structured session");
    expect(log).toContain("session_observed:false");
  });
});
