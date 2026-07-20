import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 3_000;
const SLOW_EXEC_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 2_000;
const CLOSE_TIMEOUT_MS = 2_000;
const CLEANUP_GRACE_MS = 100;

type CloseResult = [code: number | null, signal: NodeJS.Signals | null];

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function closesWithin(closed: Promise<CloseResult>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function forceClose(child: ChildProcess, closed: Promise<CloseResult>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && !(await closesWithin(closed, CLEANUP_GRACE_MS))) {
    child.kill("SIGKILL");
  }
  await bounded(closed, CLOSE_TIMEOUT_MS, "fake-agent did not close after forced cleanup");
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

describe("fake-agent", () => {
  it("emits a resumable session and usage", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "normal", "--prompt", "first", "--resume", "session-7"
    ], { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS });
    const events = parseJsonLines(stdout);
    expect(events.map((event) => event.type)).toEqual([
      "ready", "session", "output", "usage", "completed"
    ]);
    expect(events).toContainEqual({ type: "session", sessionId: "session-7" });
    expect(events).toContainEqual({ type: "output", text: "completed:first" });
    expect(events).toContainEqual({ type: "usage", inputTokens: 10, outputTokens: 5 });
  });

  it("preserves a deliberately malformed JSONL line", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "malformed"
    ], { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS });

    const lines = stdout.trim().split(/\r?\n/);
    expect(lines.map((line) => line === "not-json" ? line : JSON.parse(line).type)).toEqual([
      "ready", "session", "not-json", "output", "usage", "completed"
    ]);
  });

  it("emits an approval marker before completing", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "approval"
    ], { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS });
    const events = parseJsonLines(stdout);

    expect(events.map((event) => event.type)).toEqual([
      "ready", "session", "output", "output", "usage", "completed"
    ]);
    expect(events[2]).toEqual({ type: "output", text: "APPROVAL_REQUIRED" });
  });

  it("exits with code 23 before emitting completion when it crashes", async () => {
    const result = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "crash"
    ], { cwd: process.cwd(), timeout: EXEC_TIMEOUT_MS }).catch(
      (error: NodeJS.ErrnoException & { code?: number; stdout?: string }) => error
    );

    expect(result.code).toBe(23);
    const events = parseJsonLines(result.stdout ?? "");
    expect(events.map((event) => event.type)).toEqual(["ready", "session"]);
  });

  it("keeps silent mode alive until explicitly cleaned up", async () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "silent"
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close") as Promise<CloseResult>;

    try {
      await bounded(once(child.stdout, "data"), READY_TIMEOUT_MS, "silent mode did not become ready");
      const state = await Promise.race([
        closed.then(() => "closed"),
        new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 150))
      ]);
      expect(state).toBe("running");
    } finally {
      await forceClose(child, closed);
    }
  });

  it("streams ten slow outputs before completing", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "slow"
    ], { cwd: process.cwd(), timeout: SLOW_EXEC_TIMEOUT_MS });
    const events = parseJsonLines(stdout);
    const outputs = events.filter((event) => event.type === "output");

    expect(outputs).toHaveLength(10);
    expect(events.at(-1)).toEqual({ type: "completed", exitCode: 0 });
  }, 12_000);

  it.skipIf(process.platform === "win32")("reports interruption when a silent process receives SIGINT", async () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "silent"
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close") as Promise<CloseResult>;
    let stdout = "";
    const ready = new Promise<void>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('"type":"session"')) resolve();
      });
    });

    try {
      await bounded(ready, READY_TIMEOUT_MS, "interrupt target did not become ready");
      child.kill("SIGINT");
      const [code] = await bounded(closed, CLOSE_TIMEOUT_MS, "interrupt target did not close after SIGINT");
      expect(parseJsonLines(stdout)).toContainEqual({ type: "interrupted" });
      expect(code).toBe(130);
    } finally {
      await forceClose(child, closed);
    }
  });
});
