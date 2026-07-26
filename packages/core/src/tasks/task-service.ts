import { randomUUID } from "node:crypto";
import type {
  CompanyDefinition,
  TaskRecord,
  TaskState
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../storage/core-store.js";

const legalTransitions: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ["ready"],
  ready: ["running"],
  running: ["review", "blocked", "failed"],
  review: ["completed", "ready", "blocked"],
  completed: [],
  blocked: ["ready"],
  failed: ["ready", "blocked"]
};

type NewTask = Omit<TaskRecord, "createdEventId" | "updatedEventId">;

function event(
  type: string,
  actorId: string,
  taskId: string,
  payload: Record<string, unknown> = {}
): NewEvent {
  return {
    id: randomUUID(),
    type,
    actorId,
    taskId,
    causationEventId: null,
    payload
  };
}

function eventTypeForTransition(next: TaskState): string {
  switch (next) {
    case "draft":
      return "task.created";
    case "ready":
      return "task.ready";
    case "running":
      return "task.started";
    case "review":
      return "task.review_requested";
    case "completed":
      return "task.completed";
    case "blocked":
      return "task.blocked";
    case "failed":
      return "task.failed";
  }
}

export class TaskService {
  constructor(
    private readonly store: CoreStore,
    private readonly companyId: string,
    private readonly company: CompanyDefinition,
    private readonly leaderId: string
  ) {}

  create(input: NewTask): TaskRecord {
    if (this.store.getTask(this.companyId, input.id) !== null) {
      throw new Error(`task already exists: ${input.id}`);
    }
    if (input.status !== "draft") {
      throw new Error("new task must be draft");
    }
    if (input.ownerEmployeeId !== null) {
      throw new Error("new task must not have an owner");
    }

    this.#assertNoDependencyCycle(input);
    const created = event("task.created", "core", input.id);
    const record: TaskRecord = {
      ...input,
      dependencies: [...input.dependencies],
      acceptanceCriteria: [...input.acceptanceCriteria],
      artifacts: [...input.artifacts],
      evidence: [...input.evidence],
      createdEventId: created.id,
      updatedEventId: created.id
    };
    this.store.putTask(this.companyId, record, [created]);
    return record;
  }

  get(taskId: string): TaskRecord {
    const record = this.store.getTask(this.companyId, taskId);
    if (record === null) throw new Error(`task not found: ${taskId}`);
    return record;
  }

  list(): TaskRecord[] {
    return this.store.listTasks(this.companyId);
  }

  assign(taskId: string, employeeId: string): TaskRecord {
    const record = this.get(taskId);
    this.#assertTransition(record.status, "ready");

    const employee = this.company.employees.find((item) => item.id === employeeId);
    if (employee === undefined) throw new Error(`unknown employee: ${employeeId}`);
    if (employee.workspace !== "git_worktree") {
      throw new Error(`employee requires git_worktree workspace: ${employeeId}`);
    }
    for (const dependencyId of record.dependencies) {
      if (this.store.getTask(this.companyId, dependencyId) === null) {
        throw new Error(`dependency not found: ${dependencyId}`);
      }
    }

    const assigned = event("task.assigned", "core", taskId, { assignee: employeeId });
    const updated: TaskRecord = {
      ...record,
      ownerEmployeeId: employeeId,
      status: "ready",
      updatedEventId: assigned.id
    };
    this.store.putTask(this.companyId, updated, [assigned]);
    return updated;
  }

  transition(taskId: string, next: TaskState, actorId: string): TaskRecord {
    const record = this.get(taskId);
    this.#assertTransition(record.status, next);
    this.#assertGenericTransition(record.status, next);
    const actor = this.company.employees.find((employee) => employee.id === actorId);
    if (actor === undefined) throw new Error(`unknown employee: ${actorId}`);
    if (next === "running") {
      this.#assertDependenciesComplete(record);
      if (record.ownerEmployeeId !== actorId) throw new Error("task owner required");
    }
    if (next === "completed") {
      if (actor.workspace !== "review_package") {
        throw new Error("review permission required");
      }
      if (record.artifacts.length === 0 || record.evidence.length === 0) {
        throw new Error("submission evidence required");
      }
    }

    const changed = event(eventTypeForTransition(next), actorId, taskId, {
      previousStatus: record.status,
      status: next
    });
    const updated: TaskRecord = {
      ...record,
      status: next,
      updatedEventId: changed.id
    };
    this.store.putTask(this.companyId, updated, [changed]);
    return updated;
  }

  submit(
    taskId: string,
    actorId: string,
    artifacts: string[],
    evidence: string[]
  ): TaskRecord {
    const record = this.get(taskId);
    this.#assertTransition(record.status, "review");
    if (record.ownerEmployeeId !== actorId) throw new Error("task owner required");
    if (artifacts.length === 0) throw new Error("artifacts required");
    if (evidence.length === 0) throw new Error("evidence required");

    const submitted = event("task.submitted", actorId, taskId, {
      artifacts: [...artifacts],
      evidence: [...evidence]
    });
    const reviewRequested = event("task.review_requested", actorId, taskId, {
      submittedEventId: submitted.id
    });
    const updated: TaskRecord = {
      ...record,
      status: "review",
      artifacts: [...artifacts],
      evidence: [...evidence],
      updatedEventId: reviewRequested.id
    };
    this.store.putTask(this.companyId, updated, [submitted, reviewRequested]);
    return updated;
  }

  retry(taskId: string, actorId: string): TaskRecord {
    const record = this.get(taskId);
    const hasRetryRemaining = record.retryCount < this.company.limits.maxTaskRetry;
    const next: TaskState = hasRetryRemaining ? "ready" : "blocked";
    this.#assertTransition(record.status, next);

    const changed = event(
      hasRetryRemaining ? "task.retry_scheduled" : "task.blocked",
      actorId,
      taskId,
      { retryCount: hasRetryRemaining ? record.retryCount + 1 : record.retryCount }
    );
    const updated: TaskRecord = {
      ...record,
      status: next,
      retryCount: hasRetryRemaining ? record.retryCount + 1 : record.retryCount,
      updatedEventId: changed.id
    };
    this.store.putTask(this.companyId, updated, [changed]);
    return updated;
  }

  reject(taskId: string, reviewerId: string, findings: string[]): TaskRecord {
    const record = this.get(taskId);
    if (findings.length === 0) throw new Error("findings required");

    const reviewLoopCount = record.reviewLoopCount + 1;
    const next: TaskState = reviewLoopCount < this.company.limits.maxReviewLoops
      ? "ready"
      : "blocked";
    this.#assertTransition(record.status, next);

    const changed = event(
      next === "ready" ? "task.rework_requested" : "task.blocked",
      reviewerId,
      taskId,
      { findings: [...findings], reviewLoopCount }
    );
    const updated: TaskRecord = {
      ...record,
      status: next,
      reviewLoopCount,
      updatedEventId: changed.id
    };
    this.store.putTask(this.companyId, updated, [changed]);
    return updated;
  }

  unblock(taskId: string, actorId: string): TaskRecord {
    const record = this.get(taskId);
    this.#assertTransition(record.status, "ready");
    if (actorId !== "owner") {
      const actor = this.company.employees.find((employee) => employee.id === actorId);
      if (actor === undefined) throw new Error(`unknown employee: ${actorId}`);
      if (actorId !== this.leaderId) {
        throw new Error("leader permission required");
      }
    }

    const changed = event("task.unblocked", actorId, taskId, {
      previousStatus: record.status,
      status: "ready",
      retryCount: record.retryCount,
      reviewLoopCount: record.reviewLoopCount
    });
    const updated: TaskRecord = {
      ...record,
      status: "ready",
      updatedEventId: changed.id
    };
    this.store.putTask(this.companyId, updated, [changed]);
    return updated;
  }

  #assertTransition(current: TaskState, next: TaskState): void {
    if (!legalTransitions[current].includes(next)) {
      throw new Error(`illegal task transition: ${current} -> ${next}`);
    }
  }

  #assertGenericTransition(current: TaskState, next: TaskState): void {
    if (current === "draft" && next === "ready") {
      throw new Error("use assign for draft -> ready");
    }
    if (current === "running" && next === "review") {
      throw new Error("use submit for running -> review");
    }
    if (current === "review" && (next === "ready" || next === "blocked")) {
      throw new Error(`use reject for review -> ${next}`);
    }
    if (current === "failed" && (next === "ready" || next === "blocked")) {
      throw new Error(`use retry for failed -> ${next}`);
    }
    if (current === "blocked" && next === "ready") {
      throw new Error("blocked task requires user intervention");
    }
  }

  #assertDependenciesComplete(record: TaskRecord): void {
    const incomplete = record.dependencies.some((dependencyId) => {
      const dependency = this.store.getTask(this.companyId, dependencyId);
      return dependency === null || dependency.status !== "completed";
    });
    if (incomplete) throw new Error(`dependencies incomplete: ${record.id}`);
  }

  #assertNoDependencyCycle(proposed: NewTask): void {
    const dependencies = new Map(
      this.list().map((record) => [record.id, record.dependencies] as const)
    );
    dependencies.set(proposed.id, proposed.dependencies);

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (taskId: string): void => {
      if (visiting.has(taskId)) throw new Error(`dependency cycle: ${taskId}`);
      if (visited.has(taskId)) return;

      visiting.add(taskId);
      for (const dependencyId of dependencies.get(taskId) ?? []) {
        visit(dependencyId);
      }
      visiting.delete(taskId);
      visited.add(taskId);
    };

    for (const taskId of dependencies.keys()) visit(taskId);
  }
}
