interface AgentTownApi {
  health(): Promise<unknown>;
  startFake(mode: "normal" | "slow"): Promise<unknown>;
  sendInput(text: string): Promise<unknown>;
  resize(cols: number, rows: number): Promise<unknown>;
  subscribeOutput(callback: (text: string) => void): () => void;
}

declare global {
  interface Window {
    agentTown: AgentTownApi;
  }
}

const terminal = document.querySelector<HTMLElement>("#terminal");
const input = document.querySelector<HTMLInputElement>("#input");
const send = document.querySelector<HTMLButtonElement>("#send");
if (!terminal || !input || !send) throw new Error("terminal controls are missing");

window.agentTown.subscribeOutput((text) => {
  terminal.textContent += text;
  terminal.scrollTop = terminal.scrollHeight;
});

send.addEventListener("click", () => {
  void window.agentTown.sendInput(input.value);
  input.value = "";
});

const resize = () => {
  const cols = Math.max(20, Math.floor(terminal.clientWidth / 8));
  const rows = Math.max(5, Math.floor(terminal.clientHeight / 18));
  void window.agentTown.resize(cols, rows).catch(() => undefined);
};
new ResizeObserver(resize).observe(terminal);

async function bootstrap() {
  await window.agentTown.health();
  await window.agentTown.startFake("slow");
  resize();
}

void bootstrap();
