import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

const execFileAsync = promisify(execFile);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

async function forceKillTree(pid: number): Promise<void> {
  if (process.platform !== "win32" || !isProcessAlive(pid)) return;
  await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    timeout: 2_000
  }).catch(() => undefined);
}

describe("runProcess", () => {
  it("captures a completed process without printing environment values", async () => {
    const result = await runProcess({
      file: process.execPath,
      args: ["-e", "process.stdout.write('ordinary-output')"],
      cwd: process.cwd(),
      env: { AGENTTOWN_PROCESS_TEST: "not-emitted" },
      timeoutMs: 2_000
    });

    expect(result.command).toEqual([process.execPath, "-e", "process.stdout.write('ordinary-output')"]);
    expect(result.rawOutput).toBe("ordinary-output");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.rawOutput).not.toContain("not-emitted");
  });

  it("rejects a startup error without waiting for the run timeout", async () => {
    const wallStartedAt = Date.now();
    await expect(runProcess({
      file: "agenttown-definitely-missing-executable.exe",
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000
    })).rejects.toThrow();
    expect(Date.now() - wallStartedAt).toBeLessThan(2_000);
  });

  it.runIf(process.platform === "win32")(
    "terminates the complete Windows process tree after a bounded timeout",
    async () => {
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });",
        "console.log(JSON.stringify({ parentPid: process.pid, grandchildPid: grandchild.pid }));",
        "setInterval(() => {}, 1000);"
      ].join("");
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;

      try {
        const wallStartedAt = Date.now();
        const result = await runProcess({
          file: process.execPath,
          args: ["-e", parentScript],
          cwd: process.cwd(),
          timeoutMs: 250
        });
        const wallDurationMs = Date.now() - wallStartedAt;
        const pidLine = result.rawOutput.split(/\r?\n/u).find((line) => line.startsWith("{"));
        expect(pidLine).toBeDefined();
        ({ parentPid, grandchildPid } = JSON.parse(pidLine!) as {
          parentPid: number;
          grandchildPid: number;
        });

        expect(result.timedOut).toBe(true);
        expect(wallDurationMs).toBeLessThan(4_000);
        expect(await waitForProcessExit(parentPid, 2_000)).toBe(true);
        expect(await waitForProcessExit(grandchildPid, 2_000)).toBe(true);
      } finally {
        if (parentPid !== undefined) await forceKillTree(parentPid);
        if (grandchildPid !== undefined) await forceKillTree(grandchildPid);
      }
    },
    10_000
  );
});
