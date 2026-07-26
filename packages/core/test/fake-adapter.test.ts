import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  AgentMessage,
  SessionHandle,
  StartSessionInput
} from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/agents/fake-adapter.js";
import { createTemporaryProject } from "./helpers.js";

const fakeRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fake-agent"
);

function startInput(
  employeeId: string,
  scenario: string,
  projectRoot: string
): StartSessionInput {
  return {
    employeeId,
    role: "Developer",
    projectRoot,
    scenario
  };
}

function message(taskId: string, messageId = "message-1"): AgentMessage {
  return {
    messageId,
    employeeId: "developer",
    taskId,
    text: "implement",
    actionRequest: null
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("FakeAgentAdapter", () => {
  it("starts, sends, reports usage, interrupts and resumes", async () => {
    const project = await createTemporaryProject();
    const adapter = new FakeAgentAdapter({
      executable: process.execPath,
      packageRoot: fakeRoot
    });
    const handles: SessionHandle[] = [];

    expect(await adapter.detect()).toMatchObject({ available: true });
    expect(await adapter.capabilities()).toEqual({
      nativeResume: "supported",
      structuredOutput: "supported",
      nonInteractive: "supported",
      interrupt: "supported",
      parallelSessions: "supported",
      tokenUsage: "supported",
      contextUsage: "unknown",
      interactiveTakeover: "unsupported"
    });

    try {
      const input = startInput("developer", "complete", project.root);
      const first = await adapter.start(input);
      handles.push(first);
      const events = await collect(adapter.send(first, message("task-1")));
      expect(events.some((event) => event.type === "action.proposed")).toBe(true);
      expect(await adapter.usage(first)).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      });
      expect(await adapter.interrupt(first)).toEqual({ interrupted: true });

      const resumed = await adapter.resume({
        ...input,
        previous: first,
        handoff: "continue task-1"
      });
      handles.push(resumed);
      expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
      await adapter.stop(resumed);

      await expect(readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      )).resolves.toContain("\"type\":\"action.proposed\"");
    } finally {
      await Promise.all(handles.map(async (handle) => {
        await adapter.stop(handle).catch(() => undefined);
      }));
      await project.cleanup();
    }
  });

  it("preserves malformed output and recovers on the next send", async () => {
    const project = await createTemporaryProject();
    const adapter = new FakeAgentAdapter({
      executable: process.execPath,
      packageRoot: fakeRoot
    });
    let handle: SessionHandle | undefined;

    try {
      handle = await adapter.start(startInput(
        "developer",
        "malformed-once",
        project.root
      ));
      const malformed = await collect(adapter.send(
        handle,
        message("task-1", "message-1")
      ));
      expect(malformed).toEqual([{
        type: "adapter.error",
        code: "invalid_json",
        message: "Fake Agent emitted invalid JSON"
      }]);

      const recovered = await collect(adapter.send(
        handle,
        message("task-1", "message-2")
      ));
      expect(recovered.some((event) => event.type === "action.proposed")).toBe(true);
      await expect(readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      )).resolves.toContain("not-json");
    } finally {
      if (handle !== undefined) {
        await adapter.stop(handle).catch(() => undefined);
      }
      await project.cleanup();
    }
  });

  it("rejects an invalid employee ID before constructing a log path", async () => {
    const project = await createTemporaryProject();
    const adapter = new FakeAgentAdapter({
      executable: process.execPath,
      packageRoot: fakeRoot
    });

    try {
      await expect(adapter.start(startInput(
        "../outside",
        "complete",
        project.root
      ))).rejects.toThrow("invalid employee id");
    } finally {
      await project.cleanup();
    }
  });
});
