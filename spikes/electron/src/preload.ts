import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("agentTown", {
  health: () => ipcRenderer.invoke("core:health"),
  startFake: (mode: "normal" | "slow") => ipcRenderer.invoke("core:start-fake", mode),
  sendInput: (text: string) => ipcRenderer.invoke("core:input", text),
  resize: (cols: number, rows: number) => ipcRenderer.invoke("core:resize", cols, rows),
  subscribeOutput: (callback: (text: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: { type?: string; text?: unknown }) => {
      if (message.type !== "output" || typeof message.text !== "string") return;
      callback(message.text);
      ipcRenderer.send("renderer:output-seen");
    };
    ipcRenderer.on("core:output", listener);
    return () => ipcRenderer.off("core:output", listener);
  }
});
