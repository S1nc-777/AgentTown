import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const spikeRoot = fileURLToPath(new URL("..", import.meta.url));
const packagedExecutable = process.env.AGENTTOWN_PACKAGED_ELECTRON;
const electronExecutable = packagedExecutable ?? (createRequire(import.meta.url)("electron") as string);

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Electron exit timed out")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function waitForOutput(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`UI output timed out; stderr=${stderr}`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!stdout.includes('"type":"ui_received_output"')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Electron exited before output (${code}); stderr=${stderr}`));
    });
  });
}

function request(pipeName: string, value: Record<string, unknown>, timeoutMs = 5_000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let socket: Socket | undefined;
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("core request timed out")), timeoutMs);
    const finish = (error?: Error, response?: Record<string, unknown>) => {
      clearTimeout(timeout);
      socket?.destroy();
      error ? reject(error) : resolve(response ?? {});
    };
    socket = connect(`\\\\.\\pipe\\${pipeName}`, () => socket?.write(`${JSON.stringify(value)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (response.type === value.type || response.type === "error") return finish(undefined, response);
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

describe.runIf(process.platform === "win32")("Electron detached core launch", () => {
  it("launches a missing core detached and leaves it healthy after UI exit", async () => {
    const pipeName = `agenttown-probe-${randomUUID()}`;
    const startedAt = Date.now();
    const args = packagedExecutable
      ? ["--pipe-name", pipeName, "--test-close-after-output"]
      : [".", "--pipe-name", pipeName, "--test-close-after-output"];
    const electron = spawn(electronExecutable, args, {
      cwd: packagedExecutable ? dirname(packagedExecutable) : spikeRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
    });
    try {
      await waitForOutput(electron, 20_000);
      await expect(waitForExit(electron, 10_000)).resolves.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(30_000);
      await expect(request(pipeName, { type: "health" })).resolves.toEqual({ type: "health", status: "ok" });
    } finally {
      if (electron.exitCode === null) electron.kill();
      await waitForExit(electron, 5_000).catch(() => undefined);
      await request(pipeName, { type: "shutdown" }).catch(() => undefined);
    }
  }, 40_000);
});
