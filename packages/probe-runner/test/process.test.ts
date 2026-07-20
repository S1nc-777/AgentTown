import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

const execFileAsync = promisify(execFile);

interface WindowsProcessIdentity {
  ProcessId: number;
  CreationDate: string;
  CommandLine: string | null;
}

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

async function queryWindowsProcessIdentities(
  pids: number[],
  timeoutMs = 5_000
): Promise<WindowsProcessIdentity[]> {
  if (pids.length === 0) return [];
  const filter = pids.map((pid) => `ProcessId = ${pid}`).join(" OR ");
  const command = [
    `$filter = '${filter}'`,
    "$items = @(Get-CimInstance Win32_Process -Filter $filter | Select-Object ProcessId,CreationDate,CommandLine)",
    "ConvertTo-Json -InputObject $items -Compress"
  ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf8", windowsHide: true, timeout: timeoutMs }
  );
  const parsed = JSON.parse(stdout) as WindowsProcessIdentity[] | WindowsProcessIdentity;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function isExpectedIdentity(
  actual: WindowsProcessIdentity,
  expectedPid: number,
  nonce: string
): boolean {
  return actual.ProcessId === expectedPid
    && typeof actual.CreationDate === "string"
    && actual.CreationDate.length > 0
    && actual.CommandLine?.includes(nonce) === true;
}

async function forceKillVerifiedProcesses(
  expectedPids: number[],
  nonce: string
): Promise<void> {
  if (process.platform !== "win32" || expectedPids.length === 0) return;
  const actualProcesses = await queryWindowsProcessIdentities(expectedPids);
  for (const actual of actualProcesses) {
    if (actual.CommandLine === null
      || !expectedPids.includes(actual.ProcessId)
      || !isExpectedIdentity(actual, actual.ProcessId, nonce)
      || !actual.CommandLine.includes("node.exe")) {
      throw new Error(`Refusing to taskkill PID ${actual.ProcessId}: Win32_Process identity changed`);
    }
  }
  for (const actual of actualProcesses) {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(actual.ProcessId), "/T", "/F"], {
        windowsHide: true,
        timeout: 2_000
      });
    } catch (error) {
      const [remaining] = await queryWindowsProcessIdentities([actual.ProcessId]);
      if (!remaining) continue;
      if (!isExpectedIdentity(remaining, actual.ProcessId, nonce)) {
        throw new Error(`Refusing further cleanup for PID ${actual.ProcessId}: identity changed`, {
          cause: error
        });
      }
      throw new Error(`Verified test process ${actual.ProcessId} survived taskkill`, { cause: error });
    }
  }
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
      const nonce = `agenttown-tree-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const identityDirectory = await mkdtemp(join(tmpdir(), "agenttown-tree-identity-"));
      const identityPath = join(identityDirectory, "pids.json");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const nonce = process.argv[1];",
        "const identityPath = process.argv[2];",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', nonce], { detached: true, stdio: 'ignore', windowsHide: true });",
        "const identity = { parentPid: process.pid, grandchildPid: grandchild.pid, nonce };",
        "writeFileSync(identityPath, JSON.stringify(identity), 'utf8');",
        "console.log(JSON.stringify(identity));",
        "setInterval(() => {}, 1000);"
      ].join("");
      let parentPid: number | undefined;
      let grandchildPid: number | undefined;

      try {
        const wallStartedAt = Date.now();
        const result = await runProcess({
          file: process.execPath,
          args: ["-e", parentScript, nonce, identityPath],
          cwd: process.cwd(),
          timeoutMs: 750
        });
        const wallDurationMs = Date.now() - wallStartedAt;
        const pidLine = result.rawOutput.split(/\r?\n/u).find((line) => line.startsWith("{"));
        expect(pidLine).toBeDefined();
        const payload = JSON.parse(pidLine!) as {
          parentPid: number;
          grandchildPid: number;
          nonce: string;
        };
        ({ parentPid, grandchildPid } = payload);

        expect(payload.nonce).toBe(nonce);
        expect(result.timedOut).toBe(true);
        expect(wallDurationMs).toBeLessThan(4_000);
        expect(await waitForProcessExit(parentPid, 2_000)).toBe(true);
        expect(await waitForProcessExit(grandchildPid, 2_000)).toBe(true);
      } finally {
        const recorded = await readFile(identityPath, "utf8")
          .then((text) => JSON.parse(text) as { parentPid: number; grandchildPid: number; nonce: string })
          .catch(() => undefined);
        if (recorded?.nonce === nonce) {
          await forceKillVerifiedProcesses([recorded.parentPid, recorded.grandchildPid], nonce);
        }
        await rm(identityDirectory, { recursive: true, force: true });
      }
    },
    10_000
  );
});
