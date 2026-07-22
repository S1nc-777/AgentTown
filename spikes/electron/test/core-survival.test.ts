import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const spikeRoot = fileURLToPath(new URL("..", import.meta.url));
const electronExecutable = createRequire(import.meta.url)("electron") as string;
const liveChildren = new Set<ChildProcess>();

function waitForLine(child: ChildProcess, predicate: (line: string) => boolean, timeoutMs = 10_000) {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("timed out waiting for child output")), timeoutMs);
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) return finish(undefined, line);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`child exited before output: ${code ?? signal ?? "unknown"}`));
    const finish = (error?: Error, line?: string) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve(line ?? "");
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function pipePath(pipeName: string) {
  return `\\\\.\\pipe\\${pipeName}`;
}

function request(pipeName: string, value: Record<string, unknown>, timeoutMs = 5_000) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let socket: Socket | undefined;
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("timed out waiting for core response")), timeoutMs);
    const finish = (error?: Error, response?: Record<string, unknown>) => {
      clearTimeout(timeout);
      socket?.destroy();
      error ? reject(error) : resolve(response ?? {});
    };
    socket = connect(pipePath(pipeName), () => socket?.write(`${JSON.stringify(value)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const response = JSON.parse(line) as Record<string, unknown>;
          if (response.type === value.type || response.type === "error") {
            finish(undefined, response);
            return;
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

afterEach(async () => {
  for (const child of liveChildren) {
    if (child.exitCode === null) child.kill();
    await waitForExit(child).catch(() => undefined);
  }
  liveChildren.clear();
});

describe.runIf(process.platform === "win32")("Electron independent core", () => {
  it("survives a real Electron window exit and shuts down cleanly", async () => {
    const pipeName = `agenttown-probe-${randomUUID()}`;
    const core = spawn(process.execPath, ["--import", "tsx", "src/core.ts", "--pipe-name", pipeName], {
      cwd: spikeRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    liveChildren.add(core);

    await waitForLine(core, (line) => line.includes('"type":"core_ready"'));

    const electron = spawn(
      electronExecutable,
      [".", "--pipe-name", pipeName, "--test-close-after-output"],
      {
        cwd: spikeRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
      }
    );
    liveChildren.add(electron);

    await waitForLine(electron, (line) => line.includes('"type":"ui_received_output"'), 20_000);
    await expect(waitForExit(electron, 10_000)).resolves.toBe(0);

    await expect(request(pipeName, { type: "health" })).resolves.toEqual({ type: "health", status: "ok" });
    await expect(request(pipeName, { type: "shutdown" })).resolves.toEqual({ type: "shutdown", status: "ok" });
    await expect(waitForExit(core)).resolves.toBe(0);
  }, 40_000);
});
