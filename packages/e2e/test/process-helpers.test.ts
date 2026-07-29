import { describe, expect, it } from "vitest";
import {
  CapturedProcessError,
  capture,
  connectOrTerminateCapturedProcess,
  runCapturedCommand
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
});
