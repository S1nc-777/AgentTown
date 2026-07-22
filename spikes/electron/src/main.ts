import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { app, BrowserWindow, ipcMain } from "electron";
import { JsonLineDecoder, encodeMessage } from "./protocol.js";

type Message = Record<string, unknown>;

class CoreClient extends EventEmitter {
  #socket: Socket;
  #decoder = new JsonLineDecoder();
  #pending: Array<{
    expectedType: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      for (const decoded of this.#decoder.push(String(chunk))) {
        if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null) continue;
        this.#accept(decoded.value as Message);
      }
    });
    socket.once("close", () => this.#rejectAll(new Error("core disconnected")));
    socket.once("error", (error) => this.#rejectAll(error));
  }

  #accept(message: Message) {
    if (message.type === "output" || message.type === "exit") {
      this.emit("message", message);
      return;
    }
    const index = this.#pending.findIndex(
      ({ expectedType }) => message.type === expectedType || message.type === "error"
    );
    if (index < 0) return;
    const pending = this.#pending.splice(index, 1)[0];
    if (!pending) return;
    clearTimeout(pending.timeout);
    message.type === "error"
      ? pending.reject(new Error(`core request failed: ${String(message.code)}`))
      : pending.resolve(message);
  }

  #rejectAll(error: Error) {
    for (const pending of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending = [];
  }

  request(value: object, expectedType: string, timeoutMs = 5_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#pending.findIndex((pending) => pending.timeout === timeout);
        if (index >= 0) this.#pending.splice(index, 1);
        reject(new Error(`core ${expectedType} response timed out`));
      }, timeoutMs);
      this.#pending.push({ expectedType, resolve, reject, timeout });
      this.#socket.write(encodeMessage(value));
    });
  }

  close() {
    this.#socket.destroy();
  }
}

function readPipeName(): string {
  const index = process.argv.indexOf("--pipe-name");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^agenttown-probe-[A-Za-z0-9-]+$/.test(value)) {
    throw new Error("Electron requires a safe --pipe-name");
  }
  return value;
}

function openPipe(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function launchDetachedCore(pipeName: string) {
  const child = spawn(join(__dirname, "node.exe"), [join(__dirname, "core.mjs"), "--pipe-name", pipeName], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env }
  });
  child.unref();
}

async function connectCore(pipeName: string): Promise<CoreClient> {
  const path = `\\\\.\\pipe\\${pipeName}`;
  try {
    return new CoreClient(await openPipe(path));
  } catch {
    launchDetachedCore(pipeName);
  }
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return new CoreClient(await openPipe(path));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("core startup timed out");
}

const pipeName = readPipeName();
app.setPath("userData", join(tmpdir(), "agenttown-electron-spike", pipeName));
let client: CoreClient | undefined;
let window: BrowserWindow | undefined;

async function bootstrap() {
  await app.whenReady();
  client = await connectCore(pipeName);
  app.on("window-all-closed", () => app.quit());
  app.once("before-quit", () => client?.close());

  ipcMain.handle("core:health", () => client?.request({ type: "health" }, "health"));
  ipcMain.handle("core:start-fake", (_event, mode: "normal" | "slow") =>
    client?.request({ type: "start_fake", mode }, "started")
  );
  ipcMain.handle("core:input", (_event, text: string) => client?.request({ type: "input", text }, "input"));
  ipcMain.handle("core:resize", (_event, cols: number, rows: number) =>
    client?.request({ type: "resize", cols, rows }, "resize")
  );

  window = new BrowserWindow({
    width: 720,
    height: 480,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs")
    }
  });
  client.on("message", (message) => window?.webContents.send("core:output", message));

  if (process.argv.includes("--test-close-after-output")) {
    ipcMain.once("renderer:output-seen", () => {
      process.stdout.write(`${JSON.stringify({ type: "ui_received_output" })}\n`);
      const closeWindow = () => window?.close();
      if (window?.webContents.isLoading()) window.webContents.once("did-finish-load", closeWindow);
      else closeWindow();
    });
  }

  await window.loadFile(join(__dirname, "index.html"));
}

void bootstrap().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
