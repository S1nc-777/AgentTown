import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ActionProposal,
  AgentEvent
} from "@agenttown/runtime-contract";

type InputLine = {
  type: "message" | "interrupt" | "stop";
  messageId?: string;
  taskId?: string | null;
  text?: string;
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index] ?? "", process.argv[index + 1] ?? "");
}

const employeeId = args.get("--employee-id");
const scenario = args.get("--scenario");
if (employeeId === undefined || employeeId.length === 0) {
  throw new Error("--employee-id is required");
}
if (scenario === undefined || scenario.length === 0) {
  throw new Error("--scenario is required");
}

const emit = (value: AgentEvent): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
const taskLabel = (line: InputLine): string => line.taskId ?? "none";
const emitUsage = (): void => {
  emit({
    type: "usage.updated",
    inputTokens: 10,
    outputTokens: 5,
    contextTokens: null
  });
};
const emitAction = (
  line: InputLine,
  type: "task.submit" | "task.approve" | "task.reject",
  payload: Record<string, unknown>,
  reason: string
): void => {
  const action: ActionProposal = {
    schemaVersion: 1,
    actionId: randomUUID(),
    type,
    actorEmployeeId: employeeId,
    taskId: line.taskId ?? null,
    payload,
    reason,
    causationEventId: null
  };
  emit({
    type: "action.proposed",
    action
  });
};

const sessionId = args.get("--resume") ?? randomUUID();
const started = {
  type: "session.started",
  handle: {
    employeeId,
    adapter: "fake",
    internalSessionId: randomUUID(),
    nativeSessionId: sessionId
  }
} satisfies AgentEvent;

if (scenario === "crash") {
  process.stdout.write(`${JSON.stringify(started)}\n`, () => process.exit(23));
} else {
  emit(started);

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let malformedEmitted = false;

  input.on("line", (rawLine) => {
    const line = JSON.parse(rawLine) as InputLine;
    if (line.type === "stop") {
      input.close();
      process.exit(0);
    }
    if (line.type === "interrupt") {
      emit({ type: "session.interrupted", reason: "requested" });
      return;
    }
    if (line.type !== "message" || scenario === "silent") return;

    if (scenario === "malformed-once" && !malformedEmitted) {
      malformedEmitted = true;
      process.stdout.write("not-json\n");
      return;
    }

    if (scenario === "idle") {
      emit({ type: "output.completed", text: `idle:${taskLabel(line)}` });
      emitUsage();
      return;
    }

    emit({ type: "output.completed", text: `completed:${taskLabel(line)}` });
    if (scenario === "review-approve") {
      emitAction(line, "task.approve", {}, "deterministic fake approval");
    } else if (scenario === "review-reject-twice") {
      emitAction(
        line,
        "task.reject",
        { findings: ["fake:review:changes_requested"] },
        "deterministic fake rejection"
      );
    } else {
      emitAction(
        line,
        "task.submit",
        {
          artifacts: [`artifact:${taskLabel(line)}`],
          evidence: ["fake:test:pass"]
        },
        "deterministic fake completion"
      );
    }
    emitUsage();
  });
}
