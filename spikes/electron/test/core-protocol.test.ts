import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const spikeRoot = fileURLToPath(new URL("..", import.meta.url));
const children = new Set<ChildProcess>();

function pipePath(name: string) {
  return `\\\\.\\pipe\\${name}`;
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child exit timed out")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function startCore(pipeName: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/core.ts", "--pipe-name", pipeName], {
    cwd: spikeRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  children.add(child);
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`core ready timed out: ${output}`)), 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!output.includes('"type":"core_ready"')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`core exited before ready: ${code}`));
    });
  });
  return child;
}

class CoreTestClient {
  readonly socket: Socket;
  #buffer = "";
  #messages: Record<string, unknown>[] = [];
  #waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.#buffer += chunk;
      const lines = this.#buffer.split("\n");
      this.#buffer = lines.pop() ?? "";
      for (const line of lines) this.#accept(JSON.parse(line) as Record<string, unknown>);
    });
  }

  static connect(pipeName: string): Promise<CoreTestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(pipePath(pipeName));
      socket.once("connect", () => resolve(new CoreTestClient(socket)));
      socket.once("error", reject);
    });
  }

  #accept(message: Record<string, unknown>) {
    const index = this.#waiters.findIndex(({ predicate }) => predicate(message));
    if (index < 0) {
      this.#messages.push(message);
      return;
    }
    const waiter = this.#waiters.splice(index, 1)[0];
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  }

  sendRaw(text: string) {
    this.socket.write(text);
  }

  send(value: object) {
    this.sendRaw(`${JSON.stringify(value)}\n`);
  }

  waitFor(predicate: (message: Record<string, unknown>) => boolean, timeoutMs = 8_000) {
    const existing = this.#messages.findIndex(predicate);
    if (existing >= 0) return Promise.resolve(this.#messages.splice(existing, 1)[0] ?? {});
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#waiters.findIndex((waiter) => waiter.timeout === timeout);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("core response timed out"));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timeout });
    });
  }

  close() {
    this.socket.destroy();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("client closed"));
    }
    this.#waiters = [];
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
    await waitForExit(child).catch(() => undefined);
  }
  children.clear();
});

describe.runIf(process.platform === "win32")("core protocol", () => {
  it("frames chunks and rejects malformed, unknown, and invalid requests", async () => {
    const pipeName = `agenttown-probe-${randomUUID()}`;
    const core = await startCore(pipeName);
    const client = await CoreTestClient.connect(pipeName);
    try {
      client.sendRaw('{"type":"hea');
      client.sendRaw('lth"}\nnot-json\n{"type":"launch_agent"}\n{"type":"resize","cols":0,"rows":4}\n');
      await expect(client.waitFor((message) => message.type === "health")).resolves.toEqual({
        type: "health",
        status: "ok"
      });
      await expect(client.waitFor((message) => message.code === "malformed_json")).resolves.toEqual({
        type: "error",
        code: "malformed_json"
      });
      await expect(client.waitFor((message) => message.code === "unknown_request")).resolves.toEqual({
        type: "error",
        code: "unknown_request"
      });
      await expect(client.waitFor((message) => message.code === "invalid_request")).resolves.toEqual({
        type: "error",
        code: "invalid_request"
      });
      client.send({ type: "shutdown" });
      await expect(client.waitFor((message) => message.type === "shutdown")).resolves.toEqual({
        type: "shutdown",
        status: "ok"
      });
      await expect(waitForExit(core)).resolves.toBe(0);
    } finally {
      client.close();
    }
  });

  it("streams PTY output and forwards input and resize before bounded shutdown", async () => {
    const pipeName = `agenttown-probe-${randomUUID()}`;
    const core = await startCore(pipeName);
    const client = await CoreTestClient.connect(pipeName);
    let fakePid = 0;
    try {
      client.send({ type: "start_fake", mode: "slow" });
      const started = await client.waitFor((message) => message.type === "started");
      fakePid = Number(started.pid);
      expect(fakePid).toBeGreaterThan(0);
      const output = await client.waitFor(
        (message) => message.type === "output" && String(message.text).includes('"type":"ready"')
      );
      expect(output.type).toBe("output");

      client.send({ type: "input", text: "hello" });
      await expect(client.waitFor((message) => message.type === "input")).resolves.toEqual({
        type: "input",
        status: "ok"
      });
      client.send({ type: "resize", cols: 120, rows: 40 });
      await expect(client.waitFor((message) => message.type === "resize")).resolves.toEqual({
        type: "resize",
        status: "ok"
      });

      client.send({ type: "shutdown" });
      await expect(client.waitFor((message) => message.type === "shutdown")).resolves.toEqual({
        type: "shutdown",
        status: "ok"
      });
      await expect(waitForExit(core)).resolves.toBe(0);
      expect(() => process.kill(fakePid, 0)).toThrow();
    } finally {
      client.close();
    }
  }, 20_000);
});
