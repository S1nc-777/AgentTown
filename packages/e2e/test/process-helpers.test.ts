import { describe, expect, it } from "vitest";
import {
  CapturedProcessError,
  activeAdapterProcessDiagnostics,
  capture,
  connectOrTerminateCapturedProcess,
  forceReapCapturedProcessTree,
  formatErrorTree,
  parseAdapterProcessDiagnostics,
  runCapturedCommand,
  waitForCloseUntil,
  waitForCapturedProcessTreeExit
} from "../src/process-helpers.js";
import { spawn } from "node:child_process";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

describe("E2E process helpers", () => {
  it("kills and boundedly awaits a command that exceeds its phase timeout", async () => {
    let failure: CapturedProcessError | undefined;
    try {
      await runCapturedCommand({
        file: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        options: {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"]
        },
        label: "controlled hang",
        timeoutMs: 100
      });
    } catch (error) {
      if (!(error instanceof CapturedProcessError)) throw error;
      failure = error;
    }

    expect(failure).toBeDefined();
    expect(failure!.message).toContain("controlled hang failed");
    const pid = failure!.processCapture.child.pid;
    expect(pid).toBeTypeOf("number");
    expect(isProcessAlive(pid!)).toBe(false);
    expect(
      failure!.processCapture.child.exitCode !== null
      || failure!.processCapture.child.signalCode !== null
    ).toBe(true);
  });

  it("retains stdout and stderr when a command exits unsuccessfully", async () => {
    await expect(runCapturedCommand({
      file: process.execPath,
      args: [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"
      ],
      options: {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      },
      label: "controlled failure",
      timeoutMs: 2_000
    })).rejects.toMatchObject({
      message: expect.stringContaining("out")
    });
  });

  it("terminates a ready child when the following connection fails", async () => {
    const processCapture = capture(spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    ));
    const pid = processCapture.child.pid;

    await expect(connectOrTerminateCapturedProcess({
      processCapture,
      connect: async () => {
        throw new Error("controlled connect failure");
      },
      label: "controlled ready child",
      timeoutMs: 2_000
    })).rejects.toBeInstanceOf(CapturedProcessError);

    expect(pid).toBeTypeOf("number");
    expect(isProcessAlive(pid!)).toBe(false);
  });

  it("reaps a hung Core-like process and its detached child within one budget", async () => {
    const processCapture = capture(spawn(
      process.execPath,
      [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath,",
          "  ['-e', 'setInterval(() => undefined, 1000)'],",
          "  { detached: false, stdio: 'ignore' });",
          "process.stdout.write(String(child.pid) + '\\n');",
          "setInterval(() => undefined, 1000);"
        ].join(" ")
      ],
      {
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    ), { ownsProcessGroup: process.platform !== "win32" });
    const pidDeadline = Date.now() + 1_000;
    while (!/^\d+/u.test(processCapture.stdout)) {
      if (Date.now() >= pidDeadline) throw new Error("grandchild PID was not emitted");
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const grandchildPid = Number.parseInt(processCapture.stdout, 10);
    const rootPid = processCapture.child.pid!;
    const startedAt = Date.now();

    await expect(waitForCapturedProcessTreeExit({
      processCapture,
      verification: async () => ({ pids: [grandchildPid], errors: [] }),
      label: "controlled hung Core",
      totalBudgetMs: 2_000
    })).rejects.toBeInstanceOf(CapturedProcessError);

    expect(Date.now() - startedAt).toBeLessThan(2_200);
    expect(isProcessAlive(rootPid)).toBe(false);
    expect(isProcessAlive(grandchildPid)).toBe(false);
  });

  it("uses an injected owned-tree terminator and never kills verification PIDs", async () => {
    const root = capture(spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    ));
    const sentinel = capture(spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { windowsHide: true, stdio: "ignore" }
    ));
    let terminatorCalls = 0;
    try {
      await expect(forceReapCapturedProcessTree({
        processCapture: root,
        verification: async () => ({
          pids: [sentinel.child.pid!],
          errors: []
        }),
        terminateTree: async ({ processCapture, deadlineAt }) => {
          terminatorCalls += 1;
          processCapture.child.kill("SIGKILL");
          await waitForCloseUntil(processCapture, "injected root", deadlineAt);
        },
        label: "owned tree only",
        deadlineAt: Date.now() + 500
      })).rejects.toThrow("still-live diagnostic PIDs");
      expect(terminatorCalls).toBe(1);
      expect(isProcessAlive(sentinel.child.pid!)).toBe(true);
    } finally {
      if (root.child.exitCode === null && root.child.signalCode === null) {
        root.child.kill("SIGKILL");
      }
      if (
        sentinel.child.exitCode === null
        && sentinel.child.signalCode === null
      ) {
        sentinel.child.kill("SIGKILL");
      }
      await Promise.allSettled([root.closed, sentinel.closed]);
    }
  });

  it("bounds a blocked verification provider by the tree-reap deadline", async () => {
    const root = capture(spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    ));
    const budgetMs = 500;
    const startedAt = Date.now();

    await expect(forceReapCapturedProcessTree({
      processCapture: root,
      verification: () => new Promise(() => undefined),
      terminateTree: async ({ processCapture, deadlineAt }) => {
        processCapture.child.kill("SIGKILL");
        await waitForCloseUntil(processCapture, "blocked provider root", deadlineAt);
      },
      label: "blocked verification",
      deadlineAt: startedAt + budgetMs
    })).rejects.toThrow("verification provider exceeded");

    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(isProcessAlive(root.child.pid!)).toBe(false);
  });

  it("pairs reused PIDs by process instance and preserves malformed diagnostics", () => {
    const parsed = parseAdapterProcessDiagnostics([
      '2026-01-01 {"type":"adapter.process.started","employeeId":"leader","pid":42,"processInstanceId":"instance-a"}',
      '2026-01-01 {"type":"adapter.process.exited","employeeId":"leader","pid":42,"processInstanceId":"instance-a"}',
      '2026-01-01 {"type":"adapter.process.started","employeeId":"leader","pid":42,"processInstanceId":"instance-b"}',
      '2026-01-01 {"type":"adapter.process.started","employeeId":"leader"'
    ].join("\n"), "leader.jsonl");

    expect(parsed.diagnostics).toHaveLength(3);
    expect(parsed.errors).toHaveLength(1);
    expect(activeAdapterProcessDiagnostics(parsed.diagnostics)).toEqual([
      expect.objectContaining({
        pid: 42,
        processInstanceId: "instance-b"
      })
    ]);
  });

  it("formats captured output and every refresh or cleanup member error", () => {
    const processCapture = capture(spawn(
      process.execPath,
      ["-e", ""],
      { stdio: ["ignore", "pipe", "pipe"] }
    ));
    processCapture.stdout = "ORIGINAL_STDOUT_MARKER";
    processCapture.stderr = "ORIGINAL_STDERR_MARKER";
    const original = new CapturedProcessError(
      [
        "original process failure",
        processCapture.stdout,
        processCapture.stderr
      ].join("\n"),
      processCapture
    );
    const formatted = formatErrorTree(new AggregateError([
      original,
      new Error("DB_REFRESH_MARKER"),
      new Error("CLEANUP_MARKER")
    ], "combined"));

    expect(formatted).toContain("ORIGINAL_STDOUT_MARKER");
    expect(formatted).toContain("ORIGINAL_STDERR_MARKER");
    expect(formatted).toContain("DB_REFRESH_MARKER");
    expect(formatted).toContain("CLEANUP_MARKER");
  });
});
