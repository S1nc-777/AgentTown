import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("fake-agent", () => {
  it("emits a resumable session and usage", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "normal", "--prompt", "first", "--resume", "session-7"
    ], { cwd: process.cwd() });
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);
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
    ], { cwd: process.cwd() });

    expect(stdout.split(/\r?\n/)).toContain("not-json");
  });

  it("emits an approval marker before completing", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "approval"
    ], { cwd: process.cwd() });
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);

    expect(events).toContainEqual({ type: "output", text: "APPROVAL_REQUIRED" });
    expect(events.at(-1)).toEqual({ type: "completed", exitCode: 0 });
  });

  it("exits with code 23 before emitting completion when it crashes", async () => {
    const result = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "crash"
    ], { cwd: process.cwd() }).catch((error: NodeJS.ErrnoException & { code?: number; stdout?: string }) => error);

    expect(result.code).toBe(23);
    expect(result.stdout).not.toContain('"type":"completed"');
  });

  it("keeps silent mode alive until explicitly cleaned up", async () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "silent"
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");

    try {
      await Promise.race([
        once(child.stdout, "data"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("silent mode did not become ready")), 2_000))
      ]);
      const state = await Promise.race([
        closed.then(() => "closed"),
        new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 150))
      ]);
      expect(state).toBe("running");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });

  it("streams ten slow outputs before completing", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "slow"
    ], { cwd: process.cwd(), timeout: 10_000 });
    const events = stdout.trim().split(/\r?\n/).map(JSON.parse);
    const outputs = events.filter((event) => event.type === "output");

    expect(outputs).toHaveLength(10);
    expect(events.at(-1)).toEqual({ type: "completed", exitCode: 0 });
  }, 12_000);

  it.skipIf(process.platform === "win32")("reports interruption when a silent process receives SIGINT", async () => {
    const child = spawn(process.execPath, [
      "--import", "tsx", "src/cli.ts", "--mode", "silent"
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const closed = once(child, "close");
    let stdout = "";
    const ready = new Promise<void>((resolve) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('"type":"session"')) resolve();
      });
    });

    try {
      await ready;
      child.kill("SIGINT");
      await closed;
      expect(stdout.split(/\r?\n/).filter(Boolean).map(JSON.parse)).toContainEqual({ type: "interrupted" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
});
