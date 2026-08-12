import type { TaskRecord } from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import {
  renderEmployee,
  renderTasks,
  renderTimeline
} from "../src/render.js";

function task(id: string): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: [],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    conflictForTaskId: null,
    createdEventId: `created-${id}`,
    updatedEventId: `updated-${id}`
  };
}

describe("CLI rendering", () => {
  it("renders unavailable usage as unknown", () => {
    expect(renderEmployee({
      id: "reviewer",
      role: "reviewer",
      status: "idle",
      currentTaskId: null,
      usage: {
        inputTokens: null,
        outputTokens: null,
        contextTokens: null,
        capturedAt: "2026-07-27T00:00:00.000Z"
      }
    })).toContain("unknown");
  });

  it("renders tasks in stable ID order", () => {
    expect(renderTasks([task("b"), task("a")]).split(/\r?\n/u)[1]).toContain("a");
  });

  it("renders timeline in stable sequence order", () => {
    const output = renderTimeline([
      {
        sequence: 2,
        id: "event-2",
        type: "second",
        actorId: "core",
        taskId: null,
        causationEventId: null,
        payload: {},
        occurredAt: "2026-07-27T00:00:01.000Z"
      },
      {
        sequence: 1,
        id: "event-1",
        type: "first",
        actorId: "core",
        taskId: null,
        causationEventId: null,
        payload: {},
        occurredAt: "2026-07-27T00:00:00.000Z"
      }
    ]);
    expect(output.split(/\r?\n/u)[1]).toContain("first");
  });
});
