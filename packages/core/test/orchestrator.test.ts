import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentMessage,
  CompanyDefinition,
  ResumeSessionInput,
  SessionHandle,
  StartSessionInput,
  TaskRecord,
  UsageSnapshot
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/agents/session-manager.js";
import { CompanyOrchestrator } from "../src/company/orchestrator.js";
import { ActionPolicy } from "../src/policy/action-policy.js";
import { CoreStore } from "../src/storage/core-store.js";
import type { NewEvent } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";

interface PendingSend {
  message: AgentMessage;
  resolve: (events: AgentEvent[]) => void;
}

const capabilities: AgentCapabilities = {
  nativeResume: "supported",
  structuredOutput: "supported",
  nonInteractive: "supported",
  interrupt: "supported",
  parallelSessions: "supported",
  tokenUsage: "supported",
  contextUsage: "unknown",
  interactiveTakeover: "unsupported"
};

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

class ScriptedAdapter implements AgentAdapter {
  readonly startedEmployees: string[] = [];
  readonly stoppedEmployees: string[] = [];
  readonly resumedEmployees: string[] = [];
  readonly sentSessionIds: string[] = [];
  readonly failStopEmployeeIds = new Set<string>();
  activeSends = 0;
  maximumReviewerConcurrency = 0;
  failStartEmployeeId: string | null = null;
  readonly #pending = new Map<string, PendingSend[]>();
  readonly #activeByEmployee = new Map<string, number>();
  #sessionSequence = 0;

  async detect(): Promise<{ available: boolean; version: string }> {
    return { available: true, version: "scripted-1" };
  }

  async capabilities(): Promise<AgentCapabilities> {
    return capabilities;
  }

  async start(input: StartSessionInput): Promise<SessionHandle> {
    this.startedEmployees.push(input.employeeId);
    if (input.employeeId === this.failStartEmployeeId) {
      throw new Error(`start failed: ${input.employeeId}`);
    }
    return this.#handle(input.employeeId);
  }

  async *send(
    session: SessionHandle,
    message: AgentMessage
  ): AsyncIterable<AgentEvent> {
    this.sentSessionIds.push(session.internalSessionId);
    this.activeSends += 1;
    const employeeActive = (this.#activeByEmployee.get(session.employeeId) ?? 0) + 1;
    this.#activeByEmployee.set(session.employeeId, employeeActive);
    if (session.employeeId === "reviewer") {
      this.maximumReviewerConcurrency = Math.max(
        this.maximumReviewerConcurrency,
        employeeActive
      );
    }

    try {
      const events = await new Promise<AgentEvent[]>((resolvePromise) => {
        const queue = this.#pending.get(session.employeeId) ?? [];
        queue.push({ message, resolve: resolvePromise });
        this.#pending.set(session.employeeId, queue);
      });
      for (const event of events) yield event;
    } finally {
      this.activeSends -= 1;
      const remaining = (this.#activeByEmployee.get(session.employeeId) ?? 1) - 1;
      this.#activeByEmployee.set(session.employeeId, remaining);
    }
  }

  async interrupt(_session: SessionHandle): Promise<{ interrupted: boolean }> {
    return { interrupted: true };
  }

  async resume(input: ResumeSessionInput): Promise<SessionHandle> {
    this.resumedEmployees.push(input.employeeId);
    return this.#handle(input.employeeId, input.previous.nativeSessionId);
  }

  async stop(session: SessionHandle): Promise<void> {
    this.stoppedEmployees.push(session.employeeId);
    if (this.failStopEmployeeIds.has(session.employeeId)) {
      throw new Error(`stop failed: ${session.employeeId}`);
    }
  }

  async usage(_session: SessionHandle): Promise<UsageSnapshot> {
    return {
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: null,
      capturedAt: "2026-07-27T00:00:00.000Z"
    };
  }

  async complete(employeeId: string, action: ActionProposal): Promise<void> {
    const pending = await this.#take(employeeId);
    pending.resolve([
      { type: "output.completed", text: `completed:${pending.message.taskId ?? "none"}` },
      { type: "action.proposed", action },
      {
        type: "usage.updated",
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      }
    ]);
  }

  async exit(employeeId: string, exitCode = 23): Promise<void> {
    const pending = await this.#take(employeeId);
    pending.resolve([{ type: "session.exited", exitCode }]);
  }

  async waitForPending(employeeId: string): Promise<void> {
    await waitUntil(
      () => (this.#pending.get(employeeId)?.length ?? 0) > 0,
      `timed out waiting for ${employeeId}`
    );
  }

  nextTaskId(employeeId: string): string {
    const taskId = this.#pending.get(employeeId)?.[0]?.message.taskId;
    if (taskId === undefined || taskId === null) {
      throw new Error(`no pending task for ${employeeId}`);
    }
    return taskId;
  }

  async #take(employeeId: string): Promise<PendingSend> {
    await this.waitForPending(employeeId);
    const pending = this.#pending.get(employeeId)?.shift();
    if (pending === undefined) throw new Error(`no pending send for ${employeeId}`);
    return pending;
  }

  #handle(employeeId: string, nativeSessionId?: string | null): SessionHandle {
    this.#sessionSequence += 1;
    return {
      employeeId,
      adapter: "fake",
      internalSessionId: `${employeeId}-${this.#sessionSequence}`,
      nativeSessionId: nativeSessionId ?? `${employeeId}-native`
    };
  }
}

class FailingPersistenceStore extends CoreStore {
  #sessionWrites = 0;

  override putSession(
    companyId: string,
    employeeId: string,
    handle: SessionHandle,
    status: string,
    event: NewEvent
  ): void {
    super.putSession(companyId, employeeId, handle, status, event);
    this.#sessionWrites += 1;
    if (this.#sessionWrites === 2) throw new Error("injected session persistence failure");
  }
}

function companyFixture(): CompanyDefinition {
  return {
    schemaVersion: 1,
    company: {
      name: "Parallel Fake Company",
      mission: "Complete tasks deterministically",
      successCriteria: ["All tasks are reviewed"],
      operatingRules: ["Every task has one owner"]
    },
    employees: [
      {
        id: "leader",
        role: "product_lead",
        agent: "fake",
        reportsTo: "owner",
        workspace: "read_only"
      },
      {
        id: "developer-a",
        role: "developer",
        agent: "fake",
        reportsTo: "leader",
        workspace: "git_worktree"
      },
      {
        id: "developer-b",
        role: "developer",
        agent: "fake",
        reportsTo: "leader",
        workspace: "git_worktree"
      },
      {
        id: "reviewer",
        role: "reviewer",
        agent: "fake",
        reportsTo: "leader",
        workspace: "review_package"
      }
    ],
    limits: {
      maxTaskRetry: 1,
      maxReviewLoops: 2,
      maxParallelTasks: 2
    }
  };
}

function action(input: {
  type: ActionProposal["type"];
  actorEmployeeId: string;
  taskId?: string | null;
  payload?: Record<string, unknown>;
  reason?: string;
}): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: randomUUID(),
    type: input.type,
    actorEmployeeId: input.actorEmployeeId,
    taskId: input.taskId ?? null,
    payload: input.payload ?? {},
    reason: input.reason ?? "scripted action",
    causationEventId: null
  };
}

function proposeAction(taskId: string): ActionProposal {
  return action({
    type: "task.propose",
    actorEmployeeId: "leader",
    taskId,
    payload: {
      title: `Task ${taskId}`,
      objective: `Complete ${taskId}`,
      dependencies: [],
      acceptanceCriteria: [`${taskId} passes`]
    }
  });
}

function leaderAssigns(taskId: string, assignee: string): ActionProposal {
  return action({
    type: "task.assign",
    actorEmployeeId: "leader",
    taskId,
    payload: { assignee }
  });
}

function submitAction(taskId: string, actorEmployeeId: string): ActionProposal {
  return action({
    type: "task.submit",
    actorEmployeeId,
    taskId,
    payload: {
      artifacts: [`artifact:${taskId}`],
      evidence: [`evidence:${taskId}`]
    }
  });
}

function approveAction(taskId: string): ActionProposal {
  return action({
    type: "task.approve",
    actorEmployeeId: "reviewer",
    taskId
  });
}

interface Harness {
  company: CompanyDefinition;
  store: CoreStore;
  adapter: ScriptedAdapter;
  sessions: SessionManager;
  tasks: TaskService;
  orchestrator: CompanyOrchestrator;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.orchestrator.stopDispatching().catch(() => undefined);
    await harness.sessions.stopAll().catch(() => undefined);
    harness.store.close();
  }
});

function createHarness(store: CoreStore = new CoreStore(":memory:")): Harness {
  const company = companyFixture();
  store.initialize();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: {
      id: randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: {}
    }
  });
  const adapter = new ScriptedAdapter();
  const sessions = new SessionManager(
    () => adapter,
    store,
    "company-1",
    process.cwd()
  );
  const tasks = new TaskService(store, "company-1", company, "leader");
  const policy = new ActionPolicy(company, "leader", new Set(["reviewer"]));
  const orchestrator = new CompanyOrchestrator(
    "company-1",
    company,
    store,
    tasks,
    policy,
    sessions,
    "leader",
    "reviewer"
  );
  const harness = { company, store, adapter, sessions, tasks, orchestrator };
  harnesses.push(harness);
  return harness;
}

describe("CompanyOrchestrator", () => {
  it("runs two developers concurrently and serializes the reviewer", async () => {
    const { adapter, orchestrator, sessions, store, tasks } = createHarness();
    await orchestrator.start({});
    expect(adapter.startedEmployees).toEqual([
      "leader",
      "developer-a",
      "developer-b",
      "reviewer"
    ]);
    expect(store.listSessions("company-1")).toHaveLength(4);

    await orchestrator.dispatch(proposeAction("task-a"));
    await orchestrator.dispatch(proposeAction("task-b"));
    await orchestrator.dispatch(proposeAction("task-c"));
    await orchestrator.dispatch(leaderAssigns("task-a", "developer-a"));
    await orchestrator.dispatch(leaderAssigns("task-b", "developer-b"));
    await waitUntil(() => adapter.activeSends === 2, "developers did not overlap");

    await orchestrator.dispatch(leaderAssigns("task-c", "developer-a"));
    expect(tasks.get("task-c").status).toBe("ready");
    expect(tasks.list().filter((task) => task.status === "running")).toHaveLength(2);
    expect(store.listEvents(0).some(
      (event) => event.type === "user.approval.requested"
        && event.payload.reason === "max_parallel_tasks"
    )).toBe(true);

    await adapter.complete("developer-a", submitAction("task-a", "developer-a"));
    await adapter.complete("developer-b", submitAction("task-b", "developer-b"));
    await adapter.waitForPending("reviewer");
    expect(adapter.maximumReviewerConcurrency).toBe(1);
    const firstReviewTask = adapter.nextTaskId("reviewer");
    await adapter.complete("reviewer", approveAction(firstReviewTask));
    await adapter.waitForPending("reviewer");
    const secondReviewTask = adapter.nextTaskId("reviewer");
    expect(secondReviewTask).not.toBe(firstReviewTask);
    await adapter.complete("reviewer", approveAction(secondReviewTask));

    await waitUntil(
      () => tasks.list().filter((task) => task.status === "completed").length === 2,
      "reviewed tasks did not complete"
    );
    expect(adapter.maximumReviewerConcurrency).toBe(1);
    expect(store.latestUsage("company-1", "developer-a")).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: null
    });
    expect(store.listEvents(0).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "session.started",
        "output.completed",
        "action.proposed",
        "usage.updated",
        "company.started",
        "task.assigned",
        "task.submitted",
        "task.review_requested",
        "task.completed"
      ])
    );
    expect(sessions.get("developer-a").employeeId).toBe("developer-a");
  });

  it("retries one crash and blocks the second with one user question", async () => {
    const { adapter, orchestrator, store, tasks } = createHarness();
    await orchestrator.start({});
    await orchestrator.dispatch(proposeAction("task-a"));
    await orchestrator.dispatch(leaderAssigns("task-a", "developer-a"));
    await adapter.waitForPending("developer-a");

    await adapter.exit("developer-a");
    await adapter.waitForPending("developer-a");
    expect(adapter.resumedEmployees).toEqual(["developer-a"]);
    expect(tasks.get("task-a")).toMatchObject({ status: "running", retryCount: 1 });

    await adapter.exit("developer-a");
    await waitUntil(() => tasks.get("task-a").status === "blocked", "task was not blocked");
    expect(store.listEvents(0).filter(
      (event) => event.type === "user.approval.requested"
        && event.taskId === "task-a"
    )).toHaveLength(1);
  });

  it("persists a structured user approval question", async () => {
    const { orchestrator, store } = createHarness();
    await orchestrator.start({});
    await orchestrator.dispatch(action({
      type: "user.approval.request",
      actorEmployeeId: "leader",
      payload: {
        question: "May I change the company roster?",
        options: ["pause_and_edit", "keep_roster"]
      },
      reason: "The configured roster lacks a required specialty"
    }));

    expect(store.listEvents(0).at(-1)).toMatchObject({
      type: "user.approval.requested",
      actorId: "leader",
      payload: {
        question: "May I change the company roster?",
        options: ["pause_and_edit", "keep_roster"],
        reason: "The configured roster lacks a required specialty"
      }
    });
  });

  it("blocks a developer task after two mismatched task proposals", async () => {
    const { adapter, orchestrator, store, tasks } = createHarness();
    await orchestrator.start({});
    await orchestrator.dispatch(proposeAction("task-a"));
    await orchestrator.dispatch(proposeAction("task-b"));
    await orchestrator.dispatch(leaderAssigns("task-a", "developer-a"));
    await adapter.waitForPending("developer-a");

    await adapter.complete("developer-a", submitAction("task-b", "developer-a"));
    await adapter.waitForPending("developer-a");
    await adapter.complete("developer-a", submitAction("task-b", "developer-a"));
    await waitUntil(() => tasks.get("task-a").status === "blocked", "task-a was not blocked");

    expect(tasks.get("task-b").status).toBe("draft");
    expect(store.listEvents(0).filter(
      (event) => event.type === "user.approval.requested"
        && event.taskId === "task-a"
    )).toHaveLength(1);
  });

  it("turns invalid developer proposals into the normal retry and escalation path", async () => {
    const { adapter, orchestrator, store, tasks } = createHarness();
    await orchestrator.start({});
    await orchestrator.dispatch(proposeAction("task-a"));
    await orchestrator.dispatch(leaderAssigns("task-a", "developer-a"));
    const invalidSubmission = action({
      type: "task.submit",
      actorEmployeeId: "developer-a",
      taskId: "task-a",
      payload: { artifacts: [], evidence: [] }
    });

    await adapter.complete("developer-a", invalidSubmission);
    await adapter.waitForPending("developer-a");
    expect(tasks.get("task-a")).toMatchObject({ status: "running", retryCount: 1 });
    await adapter.complete("developer-a", action({
      type: "task.assign",
      actorEmployeeId: "developer-a",
      taskId: "task-a",
      payload: { assignee: "developer-a" }
    }));
    await waitUntil(() => tasks.get("task-a").status === "blocked", "task-a was not blocked");
    expect(store.listEvents(0).filter(
      (event) => event.type === "user.approval.requested"
        && event.taskId === "task-a"
    )).toHaveLength(1);
  });

  it("does not let a reviewer decision mutate a different task", async () => {
    const { adapter, orchestrator, store, tasks } = createHarness();
    await orchestrator.start({});
    for (const [taskId, owner] of [
      ["task-a", "developer-a"],
      ["task-b", "developer-b"]
    ] as const) {
      await orchestrator.dispatch(proposeAction(taskId));
      tasks.assign(taskId, owner);
      tasks.transition(taskId, "running", owner);
      tasks.submit(taskId, owner, [`artifact:${taskId}`], [`evidence:${taskId}`]);
    }

    const review = orchestrator.requestReview("task-a");
    await adapter.waitForPending("reviewer");
    await adapter.complete("reviewer", approveAction("task-b"));
    await review;

    expect(tasks.get("task-a").status).toBe("review");
    expect(tasks.get("task-b").status).toBe("review");
    expect(store.listEvents(0).some(
      (event) => event.type === "user.approval.requested"
        && event.taskId === "task-a"
    )).toBe(true);
  });

  it("enforces capacity and actor ownership for every task.start", async () => {
    const { orchestrator, store, tasks } = createHarness();
    await orchestrator.start({});
    for (const [taskId, owner] of [
      ["task-a", "developer-a"],
      ["task-b", "developer-b"]
    ] as const) {
      await orchestrator.dispatch(proposeAction(taskId));
      tasks.assign(taskId, owner);
      tasks.transition(taskId, "running", owner);
    }
    await orchestrator.dispatch(proposeAction("task-c"));
    tasks.assign("task-c", "developer-a");

    await orchestrator.dispatch(action({
      type: "task.start",
      actorEmployeeId: "developer-a",
      taskId: "task-c"
    }));
    expect(tasks.get("task-c").status).toBe("ready");
    const capacityApproval = store.listEvents(0).filter(
      (event) => event.type === "user.approval.requested"
        && event.taskId === "task-c"
    ).at(-1);
    expect(capacityApproval?.payload).toMatchObject({
      reason: "max_parallel_tasks",
      operation: "start task task-c",
      impact: expect.any(String),
      alternatives: expect.any(Array),
      consequenceOfNonApproval: expect.any(String),
      question: expect.any(String),
      options: expect.any(Array)
    });

    tasks.transition("task-a", "failed", "developer-a");
    await expect(orchestrator.dispatch(action({
      type: "task.start",
      actorEmployeeId: "leader",
      taskId: "task-c"
    }))).rejects.toThrow("task owner required");
    expect(tasks.get("task-c").status).toBe("ready");
  });

  it("leaves rejected review work ready when running capacity is full", async () => {
    const { orchestrator, tasks } = createHarness();
    await orchestrator.start({});
    for (const [taskId, owner] of [
      ["task-a", "developer-a"],
      ["task-b", "developer-b"]
    ] as const) {
      await orchestrator.dispatch(proposeAction(taskId));
      tasks.assign(taskId, owner);
      tasks.transition(taskId, "running", owner);
    }
    await orchestrator.dispatch(proposeAction("task-c"));
    tasks.assign("task-c", "developer-a");
    tasks.transition("task-c", "running", "developer-a");
    tasks.submit("task-c", "developer-a", ["artifact:c"], ["evidence:c"]);

    await orchestrator.dispatch(action({
      type: "task.reject",
      actorEmployeeId: "reviewer",
      taskId: "task-c",
      payload: { findings: ["fix it"] }
    }));
    expect(tasks.get("task-c").status).toBe("ready");
    expect(tasks.list().filter((task) => task.status === "running")).toHaveLength(2);
  });
});

describe("SessionManager", () => {
  it("rolls back successful starts in reverse order when one employee fails", async () => {
    const { adapter, company, sessions, store } = createHarness();
    adapter.failStartEmployeeId = "reviewer";

    await expect(sessions.startAll(company, {})).rejects.toThrow("reviewer");
    expect(adapter.startedEmployees).toEqual([
      "leader",
      "developer-a",
      "developer-b",
      "reviewer"
    ]);
    expect(adapter.stoppedEmployees).toEqual([
      "developer-b",
      "developer-a",
      "leader"
    ]);
    expect(store.listSessions("company-1")).toEqual([]);
  });

  it("serializes resume before a queued send and fetches the replacement handle", async () => {
    const { adapter, company, sessions } = createHarness();
    await sessions.startAll(company, {});
    const employee = company.employees.find((item) => item.id === "developer-a");
    if (employee === undefined) throw new Error("developer-a missing");
    const firstHandle = sessions.get(employee.id);
    const message = (messageId: string): AgentMessage => ({
      messageId,
      employeeId: employee.id,
      taskId: "task-a",
      text: "work",
      actionRequest: null
    });
    const collect = async (events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => {
      const result: AgentEvent[] = [];
      for await (const event of events) result.push(event);
      return result;
    };

    const first = collect(sessions.send(employee, message("message-1")));
    await adapter.waitForPending(employee.id);
    const resume = sessions.resumeOne(employee, {
      employeeId: employee.id,
      handle: firstHandle,
      activeTaskId: "task-a",
      handoff: "continue task-a"
    });
    const second = collect(sessions.send(employee, message("message-2")));
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(adapter.resumedEmployees).toEqual([]);

    await adapter.complete(employee.id, submitAction("task-a", employee.id));
    await first;
    const resumed = await resume;
    await adapter.waitForPending(employee.id);
    await adapter.complete(employee.id, submitAction("task-a", employee.id));
    await second;

    expect(adapter.sentSessionIds.slice(-2)).toEqual([
      firstHandle.internalSessionId,
      resumed.internalSessionId
    ]);
  });

  it("rolls back every started handle when session persistence fails", async () => {
    const { adapter, company, sessions, store } = createHarness(
      new FailingPersistenceStore(":memory:")
    );

    await expect(sessions.startAll(company, {}))
      .rejects.toThrow("injected session persistence failure");
    expect(adapter.stoppedEmployees).toEqual([
      "reviewer",
      "developer-b",
      "developer-a",
      "leader"
    ]);
    expect(store.listSessions("company-1")).toEqual([]);
  });

  it("attempts every reverse-order stop and aggregates failures", async () => {
    const { adapter, company, sessions, store } = createHarness();
    await sessions.startAll(company, {});
    adapter.failStopEmployeeIds.add("reviewer");
    adapter.failStopEmployeeIds.add("developer-a");

    await expect(sessions.stopAll()).rejects.toThrow(/reviewer.*developer-a/u);
    expect(adapter.stoppedEmployees).toEqual([
      "reviewer",
      "developer-b",
      "developer-a",
      "leader"
    ]);
    expect(store.listSessions("company-1").every(
      (session) => session.status === "stopped"
    )).toBe(true);
    for (const employee of company.employees) {
      expect(() => sessions.get(employee.id)).toThrow("session not started");
    }
  });
});
