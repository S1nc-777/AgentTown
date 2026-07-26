import type { TaskRecord } from "@agenttown/runtime-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskService } from "../src/tasks/task-service.js";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture } from "./helpers.js";

type NewTask = Omit<TaskRecord, "createdEventId" | "updatedEventId">;

function task(id: string, dependencies: string[]): NewTask {
  return {
    id,
    title: `Task ${id}`,
    objective: `Complete ${id}`,
    ownerEmployeeId: null,
    dependencies,
    acceptanceCriteria: [`${id} is complete`],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: []
  };
}

function advanceToReview(service: TaskService, taskId: string): TaskRecord {
  const existing = service.list().find((record) => record.id === taskId);
  if (existing === undefined) {
    service.create(task(taskId, []));
    service.assign(taskId, "developer");
  } else if (existing.status === "draft") {
    service.assign(taskId, "developer");
  }
  service.transition(taskId, "running", "developer");
  return service.submit(taskId, "developer", [`${taskId}.patch`], [`${taskId} tests pass`]);
}

describe("TaskService", () => {
  let store: CoreStore;
  let service: TaskService;

  beforeEach(() => {
    const company = companyDefinitionFixture();
    store = new CoreStore(":memory:");
    store.initialize();
    store.createCompany({
      id: "company-1",
      definition: company,
      event: {
        id: "company-created",
        type: "company.created",
        actorId: "owner",
        taskId: null,
        causationEventId: null,
        payload: {}
      }
    });
    service = new TaskService(store, "company-1", company);
  });

  afterEach(() => {
    store.close();
  });

  it("rejects a dependency cycle", () => {
    service.create(task("a", ["b"]));
    expect(() => service.create(task("b", ["a"]))).toThrow("dependency cycle");
  });

  it("does not start before dependencies complete", () => {
    service.create(task("build", []));
    service.create(task("test", ["build"]));
    service.assign("test", "developer");
    expect(() => service.transition("test", "running", "leader"))
      .toThrow("dependencies incomplete");
  });

  it("allows one execution retry and blocks the second failure", () => {
    service.create(task("build", []));
    service.assign("build", "developer");
    service.transition("build", "running", "developer");
    service.transition("build", "failed", "developer");
    expect(service.retry("build", "leader").status).toBe("ready");
    service.transition("build", "running", "developer");
    service.transition("build", "failed", "developer");
    expect(service.retry("build", "leader").status).toBe("blocked");
  });

  it("blocks after two review rejections", () => {
    const record = advanceToReview(service, "build");
    service.reject(record.id, "reviewer", ["first"]);
    advanceToReview(service, "build");
    service.reject(record.id, "reviewer", ["second"]);
    expect(service.get("build").status).toBe("blocked");
  });

  it("rejects assignment while a referenced dependency is missing", () => {
    service.create(task("test", ["build"]));
    expect(() => service.assign("test", "developer")).toThrow("dependency not found");
  });

  it("requires a single git-worktree employee as the task owner", () => {
    service.create(task("build", []));
    expect(() => service.assign("build", "reviewer")).toThrow("git_worktree");
    expect(service.assign("build", "developer").ownerEmployeeId).toBe("developer");
    expect(() => service.assign("build", "developer")).toThrow("illegal task transition");
  });

  it("submits artifacts and evidence as ordered atomic events", () => {
    advanceToReview(service, "build");

    expect(service.get("build")).toMatchObject({
      status: "review",
      artifacts: ["build.patch"],
      evidence: ["build tests pass"]
    });
    expect(store.listEvents(0).map((event) => event.type)).toEqual([
      "company.created",
      "task.created",
      "task.assigned",
      "task.started",
      "task.submitted",
      "task.review_requested"
    ]);
  });

  it("requires the owner plus non-empty artifacts and evidence to submit", () => {
    service.create(task("build", []));
    service.assign("build", "developer");
    service.transition("build", "running", "developer");

    expect(() => service.submit("build", "leader", ["build.patch"], ["tests pass"]))
      .toThrow("task owner required");
    expect(() => service.submit("build", "developer", [], ["tests pass"]))
      .toThrow("artifacts required");
    expect(() => service.submit("build", "developer", ["build.patch"], []))
      .toThrow("evidence required");
  });
});
