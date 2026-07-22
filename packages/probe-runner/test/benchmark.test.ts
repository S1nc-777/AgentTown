import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runParallelProbe, type ParallelProbeHandle } from "../src/benchmark.js";
import type { RunResult } from "../src/pty.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryLogRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agenttown-parallel-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function successfulResult(id: string): RunResult {
  return {
    command: ["fixture"],
    startedAt: "2026-07-22T00:00:00.000Z",
    durationMs: 10,
    exitCode: 0,
    timedOut: false,
    rawOutput: [
      JSON.stringify({ type: "ready", pid: 1 }),
      JSON.stringify({ type: "session", sessionId: `session-${id}` }),
      JSON.stringify({ type: "completed", exitCode: 0 })
    ].join("\n") + "\n"
  };
}

describe("runParallelProbe", () => {
  it("runs three fake sessions concurrently and preserves identity", async () => {
    const result = await runParallelProbe([
      { id: "leader", adapter: "fake", prompt: "lead" },
      { id: "developer", adapter: "fake", prompt: "build" },
      { id: "reviewer", adapter: "fake", prompt: "review" }
    ], 3);

    expect(result.completed).toEqual(["leader", "developer", "reviewer"]);
    expect(new Set(result.sessionIds).size).toBe(3);
    expect(result.orphanPids).toEqual([]);
  });

  it("never exceeds the configured concurrency and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    let nextPid = 100;
    const startProbe = (spec: { id: string }): ParallelProbeHandle => {
      active += 1;
      peak = Math.max(peak, active);
      const completed = new Promise<RunResult>((resolve) => {
        setTimeout(() => {
          active -= 1;
          resolve(successfulResult(spec.id));
        }, spec.id === "one" ? 30 : 5);
      });
      return { pid: nextPid++, completed, interrupt() {}, kill() {} };
    };

    const result = await runParallelProbe([
      { id: "one", adapter: "fake", prompt: "1" },
      { id: "two", adapter: "fake", prompt: "2" },
      { id: "three", adapter: "fake", prompt: "3" },
      { id: "four", adapter: "fake", prompt: "4" }
    ], 2, { startProbe, logRootDir: await temporaryLogRoot() });

    expect(peak).toBe(2);
    expect(result.completed).toEqual(["one", "two", "three", "four"]);
    expect(result.sessionIds).toEqual(["session-one", "session-two", "session-three", "session-four"]);
  });

  it("records a start failure without cancelling the remaining queue", async () => {
    let nextPid = 200;
    const startProbe = (spec: { id: string }): ParallelProbeHandle => {
      if (spec.id === "broken") {
        throw Object.assign(new Error("private launch detail"), { code: "EACCES" });
      }
      return {
        pid: nextPid++,
        completed: Promise.resolve(successfulResult(spec.id)),
        interrupt() {},
        kill() {}
      };
    };

    const result = await runParallelProbe([
      { id: "first", adapter: "fake", prompt: "1" },
      { id: "broken", adapter: "fake", prompt: "2" },
      { id: "last", adapter: "fake", prompt: "3" }
    ], 2, { startProbe, logRootDir: await temporaryLogRoot() });

    expect(result.completed).toEqual(["first", "last"]);
    expect(result.failed).toEqual([{ id: "broken", blocker: "start_EACCES" }]);
    expect(JSON.stringify(result)).not.toContain("private launch detail");
  });

  it("interrupts then kills unfinished handles when a worker rejects", async () => {
    const cleanup: string[] = [];
    const never = new Promise<RunResult>(() => {});
    const startProbe = (spec: { id: string }): ParallelProbeHandle => ({
      pid: spec.id === "reject" ? 301 : 302,
      completed: spec.id === "reject"
        ? Promise.reject(new Error("synthetic worker rejection"))
        : never,
      interrupt: () => cleanup.push(`interrupt:${spec.id}`),
      kill: () => cleanup.push(`kill:${spec.id}`)
    });

    await expect(runParallelProbe([
      { id: "reject", adapter: "fake", prompt: "1" },
      { id: "unfinished", adapter: "fake", prompt: "2" }
    ], 2, {
      startProbe,
      logRootDir: await temporaryLogRoot(),
      cleanupGraceMs: 1
    })).rejects.toThrow("synthetic worker rejection");

    expect(cleanup).toContain("interrupt:unfinished");
    expect(cleanup).toContain("kill:unfinished");
    expect(cleanup.indexOf("interrupt:unfinished")).toBeLessThan(cleanup.indexOf("kill:unfinished"));
  });

  it("classifies a bounded timeout as an explicit partial failure", async () => {
    const startProbe = (spec: { id: string }): ParallelProbeHandle => ({
      pid: spec.id === "slow" ? 401 : 402,
      completed: Promise.resolve(spec.id === "slow"
        ? { ...successfulResult(spec.id), exitCode: -1, timedOut: true }
        : successfulResult(spec.id)),
      interrupt() {},
      kill() {}
    });

    const result = await runParallelProbe([
      { id: "slow", adapter: "fake", prompt: "1", timeoutMs: 5 },
      { id: "healthy", adapter: "fake", prompt: "2" }
    ], 2, { startProbe, logRootDir: await temporaryLogRoot() });

    expect(result.completed).toEqual(["healthy"]);
    expect(result.failed).toEqual([{ id: "slow", blocker: "timeout" }]);
    expect(result.orphanPids).toEqual([]);
  });

  it("reports a PID that survives the bounded post-cleanup check", async () => {
    const result = await runParallelProbe([
      { id: "survivor", adapter: "fake", prompt: "1" }
    ], 1, {
      startProbe: (spec) => ({
        pid: 777,
        completed: Promise.resolve(successfulResult(spec.id)),
        interrupt() {},
        kill() {}
      }),
      isAlive: async (pid) => pid === 777,
      orphanCheckTimeoutMs: 2,
      orphanPollIntervalMs: 1,
      logRootDir: await temporaryLogRoot()
    });

    expect(result.orphanPids).toEqual([777]);
  });

  it("stops dequeuing after the first worker error and audits every started PID", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (result: RunResult) => void;
    const first = new Promise<RunResult>((_resolve, reject) => { rejectFirst = reject; });
    const second = new Promise<RunResult>((resolve) => { resolveSecond = resolve; });
    const started: string[] = [];
    const cleanup: string[] = [];
    const audited: number[] = [];
    const run = runParallelProbe([
      { id: "reject", adapter: "fake", prompt: "1" },
      { id: "racing", adapter: "fake", prompt: "2" },
      { id: "must-not-start", adapter: "fake", prompt: "3" }
    ], 2, {
      startProbe: (spec) => {
        started.push(spec.id);
        const pid = spec.id === "reject" ? 801 : 802;
        return {
          pid,
          completed: spec.id === "reject" ? first : second,
          interrupt: () => cleanup.push(`interrupt:${pid}`),
          kill: () => cleanup.push(`kill:${pid}`)
        };
      },
      isAlive: async (pid) => { audited.push(pid); return false; },
      cleanupGraceMs: 1,
      orphanCheckTimeoutMs: 1,
      orphanPollIntervalMs: 1,
      logRootDir: await temporaryLogRoot()
    });

    while (started.length < 2) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const rejected = expect(run).rejects.toThrow("first worker failed");
    rejectFirst(new Error("first worker failed"));
    resolveSecond(successfulResult("racing"));
    await rejected;

    expect(started).toEqual(["reject", "racing"]);
    expect(cleanup).toContain("interrupt:801");
    expect(cleanup).toContain("kill:801");
    expect([...new Set(audited)].sort()).toEqual([801, 802]);
  });
});
