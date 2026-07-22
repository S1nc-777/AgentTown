import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { connectCore, type CoreClient } from "./core-client.js";

function readPipeName(): string {
  const index = process.argv.indexOf("--pipe-name");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !/^agenttown-probe-[A-Za-z0-9-]+$/.test(value)) {
    throw new Error("Electron requires a safe --pipe-name");
  }
  return value;
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

const pipeName = readPipeName();
app.setPath("userData", join(tmpdir(), "agenttown-electron-spike", pipeName));
let client: CoreClient | undefined;
let window: BrowserWindow | undefined;

async function bootstrap() {
  await app.whenReady();
  client = await connectCore({ pipeName, launchCore: () => launchDetachedCore(pipeName) });
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
