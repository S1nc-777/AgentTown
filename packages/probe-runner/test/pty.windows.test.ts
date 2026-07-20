import { describe, expect, it } from "vitest";
import { runPty, type ProbeHandle } from "../src/pty.js";

const READY_TIMEOUT_MS = 3_000;
const COMPLETION_TIMEOUT_MS = 5_000;

function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

async function cleanup(handle: ProbeHandle | undefined): Promise<void> {
  if (!handle) return;
  handle.kill();
  await bounded(handle.completed, COMPLETION_TIMEOUT_MS, "ConPTY child did not exit during cleanup");
}

describe.runIf(process.platform === "win32")("runPty", () => {
  it("streams output, accepts resize, and delivers a real Ctrl+C", async () => {
    let handle: ProbeHandle | undefined;
    try {
      handle = runPty({
        file: process.execPath,
        args: ["--import", "tsx", "../fake-agent/src/cli.ts", "--mode", "slow"],
        cwd: process.cwd(),
        timeoutMs: 10_000
      });

      await bounded(
        handle.waitFor((text) => text.includes('"type":"ready"')),
        READY_TIMEOUT_MS,
        "fake Agent did not become ready"
      );
      handle.resize(120, 40);
      handle.interrupt();

      const result = await bounded(handle.completed, COMPLETION_TIMEOUT_MS, "fake Agent ignored Ctrl+C");
      expect(result.rawOutput).toContain('"type":"interrupted"');
      expect(Number.isInteger(result.exitCode)).toBe(true);
      expect(result.timedOut).toBe(false);
    } finally {
      await cleanup(handle);
    }
  });

  it("times out with bounded interrupt-to-kill escalation", async () => {
    let handle: ProbeHandle | undefined;
    try {
      handle = runPty({
        file: process.execPath,
        args: ["-e", "process.on('SIGINT', () => {}); console.log('ready'); setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 2_000
      });

      await bounded(handle.waitFor((text) => text.includes("ready")), READY_TIMEOUT_MS, "timeout target did not become ready");
      const result = await bounded(handle.completed, 7_000, "ConPTY timeout escalation was not bounded");
      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(4_000);
      expect(result.durationMs).toBeLessThan(7_000);
    } finally {
      await cleanup(handle);
    }
  }, 10_000);

});
