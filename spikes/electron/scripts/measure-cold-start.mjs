import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? "out/AgentTownElectronSpike-win32-x64/AgentTownElectronSpike.exe");

function request(pipeName, value, timeoutMs = 5_000) {
  return new Promise((resolveRequest, reject) => {
    let socket;
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("core request timed out")), timeoutMs);
    const finish = (error, response) => {
      clearTimeout(timeout);
      socket?.destroy();
      error ? reject(error) : resolveRequest(response);
    };
    socket = connect(`\\\\.\\pipe\\${pipeName}`, () => socket.write(`${JSON.stringify(value)}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const response = JSON.parse(line);
        if (response.type === value.type || response.type === "error") return finish(undefined, response);
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function measureOnce() {
  const pipeName = `agenttown-probe-${randomUUID()}`;
  const startedAt = performance.now();
  const child = spawn(executable, ["--pipe-name", pipeName, "--test-close-after-output"], {
    cwd: dirname(executable),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  try {
    const coldStartMs = await new Promise((resolveOutput, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error(`cold start timed out: ${stderr}`)), 20_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (!stdout.includes('"type":"ui_received_output"')) return;
        clearTimeout(timeout);
        resolveOutput(Math.round(performance.now() - startedAt));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`packaged app exited before output (${code}): ${stderr}`));
      });
    });
    process.stdout.write(`${JSON.stringify({ type: "cold_start_observed", coldStartMs })}\n`);
    await new Promise((resolveExit, reject) => {
      if (child.exitCode !== null) return resolveExit();
      const timeout = setTimeout(() => reject(new Error("packaged UI exit timed out")), 10_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
    });
    await request(pipeName, { type: "health" });
    await request(pipeName, { type: "shutdown" });
    return coldStartMs;
  } finally {
    if (child.exitCode === null) child.kill();
    await request(pipeName, { type: "shutdown" }).catch(() => undefined);
  }
}

const runsMs = [];
for (let index = 0; index < 3; index += 1) runsMs.push(await measureOnce());
const sorted = [...runsMs].sort((left, right) => left - right);
process.stdout.write(`${JSON.stringify({ runsMs, medianMs: sorted[1] })}\n`);
