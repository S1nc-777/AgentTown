import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { runPty, type ProbeHandle } from "../../../packages/probe-runner/src/pty.js";
import { encodeMessage, JsonLineDecoder, parseCoreRequest, type CoreRequest } from "./protocol.js";

const pipeName = readPipeName(process.argv);
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const builtFakeAgentPath = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const sourceFakeAgentPath = fileURLToPath(new URL("../../../packages/fake-agent/src/cli.ts", import.meta.url));
const fakeAgentPath = existsSync(builtFakeAgentPath) ? builtFakeAgentPath : sourceFakeAgentPath;
const clients = new Set<Socket>();
let activeAgent: ProbeHandle | undefined;
let server: Server;
let shuttingDown = false;

function readPipeName(args: string[]): string {
  const index = args.indexOf("--pipe-name");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || !/^agenttown-probe-[A-Za-z0-9-]+$/.test(value)) {
    throw new Error("--pipe-name must be a safe agenttown-probe-* name");
  }
  return value;
}

function send(socket: Socket, value: object): void {
  if (!socket.destroyed) socket.write(encodeMessage(value));
}

function broadcast(value: object): void {
  for (const client of clients) send(client, value);
}

function startFake(socket: Socket, mode: "normal" | "slow") {
  if (activeAgent) {
    send(socket, { type: "error", code: "agent_already_running" });
    return;
  }
  const handle = runPty({
    file: process.execPath,
    args: fakeAgentPath.endsWith(".ts")
      ? ["--import", "tsx", fakeAgentPath, "--mode", mode]
      : [fakeAgentPath, "--mode", mode],
    cwd: repositoryRoot,
    timeoutMs: 30_000,
    onData: (text) => broadcast({ type: "output", text })
  });
  activeAgent = handle;
  send(socket, { type: "started", pid: handle.pid });
  void handle.completed.then((result) => {
    if (activeAgent === handle) activeAgent = undefined;
    broadcast({ type: "exit", exitCode: result.exitCode, timedOut: result.timedOut });
  });
}

async function stopAgent(): Promise<void> {
  const handle = activeAgent;
  if (!handle) return;
  handle.kill();
  await Promise.race([
    handle.completed.then(() => undefined),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("PTY cleanup exceeded five seconds")), 5_000)
    )
  ]);
  if (activeAgent === handle) activeAgent = undefined;
}

async function shutdown(requester?: Socket): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await stopAgent();
    server.close();
    for (const client of clients) {
      if (client !== requester) client.destroy();
    }
    if (requester && !requester.destroyed) requester.end(encodeMessage({ type: "shutdown", status: "ok" }));
    if (requester && !requester.destroyed) {
      await Promise.race([once(requester, "close"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
      requester.destroy();
    }
    process.exit(0);
  } catch (error) {
    if (requester) send(requester, { type: "error", code: "shutdown_failed" });
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    for (const client of clients) client.destroy();
    server.close();
    process.exit(1);
  }
}

function handleRequest(socket: Socket, request: CoreRequest): void {
  switch (request.type) {
    case "health":
      send(socket, { type: "health", status: "ok" });
      break;
    case "start_fake":
      startFake(socket, request.mode);
      break;
    case "input":
      if (!activeAgent) send(socket, { type: "error", code: "no_agent" });
      else {
        activeAgent.write(request.text);
        send(socket, { type: "input", status: "ok" });
      }
      break;
    case "resize":
      if (!activeAgent) send(socket, { type: "error", code: "no_agent" });
      else {
        activeAgent.resize(request.cols, request.rows);
        send(socket, { type: "resize", status: "ok" });
      }
      break;
    case "shutdown":
      void shutdown(socket);
      break;
  }
}

server = createServer((socket) => {
  clients.add(socket);
  const decoder = new JsonLineDecoder();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    for (const decoded of decoder.push(String(chunk))) {
      if (!decoded.ok) {
        send(socket, { type: "error", code: decoded.code });
        continue;
      }
      const parsed = parseCoreRequest(decoded.value);
      if (!parsed.ok) send(socket, { type: "error", code: parsed.code });
      else handleRequest(socket, parsed.value);
    }
  });
  socket.once("close", () => clients.delete(socket));
  socket.once("error", () => socket.destroy());
});

server.once("error", (error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
server.listen(pipePath, () => {
  process.stdout.write(`${JSON.stringify({ type: "core_ready", pipeName, pid: process.pid })}\n`);
});
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
