import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type {
  ActionProposal,
  AgentEvent,
  ReviewTaskContext,
  WritableTaskContext
} from "@agenttown/runtime-contract";
import {
  GIT_FIXTURE_SCENARIOS,
  runGitFixture,
  type GitFixtureScenario
} from "./git-fixture.js";

type InputLine = {
  type: "message" | "interrupt" | "stop";
  messageId?: string;
  taskId?: string | null;
  text?: string;
  taskContext?: WritableTaskContext | ReviewTaskContext | null;
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
  type: "task.submit" | "task.approve" | "task.reject" | "task.propose" | "task.assign" | "company.complete.request",
  payload: Record<string, unknown>,
  reason: string,
  taskIdOverride?: string
): void => {
  const action: ActionProposal = {
    schemaVersion: 1,
    actionId: randomUUID(),
    type,
    actorEmployeeId: employeeId,
    taskId: taskIdOverride ?? line.taskId ?? null,
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
  let leaderMessageCount = 0;

  const gitScenario = GIT_FIXTURE_SCENARIOS.includes(scenario as GitFixtureScenario)
    ? scenario as GitFixtureScenario
    : null;

  input.on("line", async (rawLine) => {
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

    if (gitScenario !== null) {
      const taskContext = line.taskContext;
      if (taskContext === undefined || taskContext === null) {
        emit({
          type: "adapter.error",
          code: "missing_task_context",
          message: `git scenario ${gitScenario} requires a task context`
        });
        return;
      }
      try {
        const result = await runGitFixture({
          context: taskContext,
          scenario: gitScenario
        });
        emit({
          type: "output.completed",
          text: `completed:${taskLabel(line)}`
        });
        emitAction(
          line,
          result.action.type as "task.submit" | "task.approve" | "task.reject",
          result.action.payload,
          result.action.reason
        );
      } catch (error) {
        emit({
          type: "adapter.error",
          code: "git_fixture_failed",
          message: error instanceof Error ? error.message : String(error)
        });
      }
      emitUsage();
      return;
    }

    if (scenario === "git-lead-propose-assign") {
      leaderMessageCount += 1;
      emit({ type: "output.completed", text: `leader:${taskLabel(line)}:${leaderMessageCount}` });
      if (leaderMessageCount === 1) {
        emitAction(
          line,
          "task.propose",
          {
            title: "Task A",
            objective: "Complete task-a",
            dependencies: [],
            acceptanceCriteria: ["task-a evidence passes"]
          },
          "deterministic fake leader proposal",
          "task-a"
        );
      } else if (leaderMessageCount === 2) {
        emitAction(
          line,
          "task.assign",
          { assignee: "developer-a" },
          "deterministic fake leader assignment",
          "task-a"
        );
      } else {
        emitAction(
          line,
          "company.complete.request",
          {},
          "deterministic fake leader completion request",
          "task-a"
        );
      }
      emitUsage();
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
