import { randomUUID } from "node:crypto";
import type { ProbeEvent } from "@agenttown/probe-contract";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
}

const mode = args.get("--mode") ?? "normal";
const sessionId = args.get("--resume") ?? randomUUID();
const emit = (value: ProbeEvent) => process.stdout.write(`${JSON.stringify(value)}\n`);

process.once("SIGINT", () => {
  process.stdout.write(`${JSON.stringify({ type: "interrupted" } satisfies ProbeEvent)}\n`, () => process.exit(130));
});

emit({ type: "ready", pid: process.pid });
emit({ type: "session", sessionId });
if (mode === "crash") {
  process.exitCode = 23;
} else if (mode === "silent") {
  setTimeout(() => process.exit(0), 30_000);
} else {
  if (mode === "malformed") process.stdout.write("not-json\n");
  if (mode === "approval") emit({ type: "output", text: "APPROVAL_REQUIRED" });
  if (mode === "slow") {
    for (let index = 1; index <= 10; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      emit({ type: "output", text: `slow:${index}` });
    }
  } else {
    emit({ type: "output", text: `completed:${args.get("--prompt") ?? ""}` });
  }
  emit({ type: "usage", inputTokens: 10, outputTokens: 5 });
  emit({ type: "completed", exitCode: 0 });
}
