import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  runProcessWithDependencies,
  terminateWindowsProcessTree,
  type TaskkillLauncher
} from "../src/process-internals.js";

function callbackFailure(code?: string | number): Error & { code?: string | number } {
  const error = new Error("simulated taskkill failure") as Error & { code?: string | number };
  if (code !== undefined) error.code = code;
  return error;
}

function launcherCallingBack(error: Error | null): TaskkillLauncher {
  return (_pid, _timeoutMs, callback) => {
    queueMicrotask(() => callback(error));
    return { kill: vi.fn(() => true) };
  };
}

describe("terminateWindowsProcessTree", () => {
  it("rejects a taskkill callback error", async () => {
    await expect(terminateWindowsProcessTree(123, {
      launchTaskkill: launcherCallingBack(callbackFailure())
    })).rejects.toThrow(/taskkill.*failed/iu);
  });

  it("rejects a non-zero taskkill exit", async () => {
    await expect(terminateWindowsProcessTree(123, {
      launchTaskkill: launcherCallingBack(callbackFailure(1))
    })).rejects.toThrow(/taskkill.*code 1/iu);
  });

  it("rejects a taskkill callback timeout", async () => {
    await expect(terminateWindowsProcessTree(123, {
      launchTaskkill: launcherCallingBack(callbackFailure("ETIMEDOUT"))
    })).rejects.toThrow(/taskkill.*timed out/iu);
  });

  it("kills taskkill and rejects when its callback never arrives", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(() => true);
      const launchTaskkill: TaskkillLauncher = () => ({ kill });
      const completion = terminateWindowsProcessTree(123, {
        launchTaskkill,
        taskkillTimeoutMs: 20,
        hardTimeoutMs: 25
      });
      const rejection = expect(completion).rejects.toThrow(/taskkill.*did not report completion/iu);

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runProcessWithDependencies", () => {
  it.runIf(process.platform === "win32")(
    "falls back to direct-child kill and bounded rejection when tree cleanup fails",
    async () => {
      const directKill = vi.fn((child: ReturnType<typeof spawn>) => child.kill("SIGKILL"));
      const wallStartedAt = Date.now();

      await expect(runProcessWithDependencies({
        file: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        timeoutMs: 25
      }, {
        platform: "win32",
        terminateWindowsProcessTree: async () => {
          throw new Error("simulated tree cleanup failure");
        },
        killDirectChild: directKill,
        processCloseGraceMs: 250
      })).rejects.toThrow(/tree cleanup failure/iu);

      expect(directKill).toHaveBeenCalledOnce();
      expect(Date.now() - wallStartedAt).toBeLessThan(1_000);
    }
  );
});
