import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentEvent,
  AgentMessage,
  CompanyDefinition,
  EmployeeDefinition,
  TaskRecord
} from "@agenttown/runtime-contract";
import { SessionManager } from "../agents/session-manager.js";
import { ActionPolicy } from "../policy/action-policy.js";
import { CoreStore } from "../storage/core-store.js";
import { TaskService } from "../tasks/task-service.js";

function requiredTaskId(action: ActionProposal): string {
  if (action.taskId === null) throw new Error(`${action.type} requires taskId`);
  return action.taskId;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("expected non-empty string array");
  }
  return [...value] as string[];
}

function optionalStringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function assertNever(value: never): never {
  throw new Error(`unsupported action: ${JSON.stringify(value)}`);
}

export class CompanyOrchestrator {
  readonly #inFlight = new Map<string, Promise<void>>();
  #acceptingActions = false;

  constructor(
    private readonly companyId: string,
    private readonly company: CompanyDefinition,
    private readonly store: CoreStore,
    private readonly tasks: TaskService,
    private readonly policy: ActionPolicy,
    private readonly sessions: SessionManager,
    private readonly leaderId: string,
    private readonly reviewerId: string
  ) {}

  async start(scenarios: Readonly<Record<string, string>>): Promise<void> {
    try {
      await this.sessions.startAll(this.company, scenarios);
      this.store.setCompanyStatus(this.companyId, "running", {
        id: randomUUID(),
        type: "company.started",
        actorId: "owner",
        taskId: null,
        causationEventId: null,
        payload: {}
      });
      this.#acceptingActions = true;
    } catch (error) {
      await this.sessions.stopAll().catch(() => undefined);
      throw error;
    }
  }

  async dispatch(action: ActionProposal): Promise<void> {
    this.policy.validate(action);
    if (!this.#acceptingActions) throw new Error("orchestrator is not dispatching");

    switch (action.type) {
      case "task.propose":
        this.#createProposedTask(action);
        return;
      case "task.assign":
        await this.#assignAndSend(action);
        return;
      case "task.submit":
        await this.#recordSubmissionAndRequestReview(action);
        return;
      case "task.approve":
        this.tasks.transition(
          requiredTaskId(action),
          "completed",
          action.actorEmployeeId
        );
        return;
      case "task.reject":
        await this.#rejectAndMaybeRequeue(
          requiredTaskId(action),
          action.actorEmployeeId,
          requiredStringArray(action.payload.findings)
        );
        return;
      case "task.start":
      case "task.request_review":
      case "task.block":
      case "employee.message":
      case "user.approval.request":
      case "company.complete.request":
        await this.#applySupportedControlAction(action);
        return;
      default:
        assertNever(action.type);
    }
  }

  async sendTask(taskId: string): Promise<void> {
    while (true) {
      const task = this.tasks.get(taskId);
      const employee = this.#taskOwner(task);
      let failed = false;

      for await (const event of this.sessions.send(
        employee,
        this.#taskMessage(task, employee)
      )) {
        if (event.type === "action.proposed") {
          await this.dispatch(event.action);
        } else if (event.type === "adapter.error" || event.type === "session.exited") {
          failed = true;
          break;
        }
      }

      const current = this.tasks.get(taskId);
      if (current.status !== "running") return;
      if (!failed) {
        this.#recordEvent(
          "task.execution_error",
          employee.id,
          taskId,
          { reason: "session ended without a terminal action" }
        );
      }

      this.tasks.transition(taskId, "failed", employee.id);
      const retry = this.tasks.retry(taskId, this.leaderId);
      if (retry.status === "blocked") {
        this.#recordApprovalRequest(
          taskId,
          this.leaderId,
          "task_execution_retry_exhausted",
          { employeeId: employee.id }
        );
        return;
      }

      const checkpoint = {
        employeeId: employee.id,
        handle: this.sessions.get(employee.id),
        activeTaskId: taskId,
        handoff: `Retry ${taskId} after Agent session failure`
      };
      try {
        await this.sessions.resumeOne(employee, checkpoint);
      } catch {
        await this.sessions.rebuildOne(employee, checkpoint.handoff);
      }
      this.tasks.transition(taskId, "running", employee.id);
    }
  }

  async requestReview(taskId: string): Promise<void> {
    const reviewer = this.#employee(this.reviewerId);
    let decisionReceived = false;
    for await (const event of this.sessions.send(reviewer, {
      messageId: randomUUID(),
      employeeId: reviewer.id,
      taskId,
      text: `Review task ${taskId} and propose approval or rejection.`,
      actionRequest: null
    })) {
      if (event.type === "action.proposed") {
        decisionReceived = event.action.type === "task.approve"
          || event.action.type === "task.reject";
        await this.dispatch(event.action);
      } else if (event.type === "adapter.error" || event.type === "session.exited") {
        this.#recordApprovalRequest(
          taskId,
          this.leaderId,
          "reviewer_session_failed",
          { reviewerId: reviewer.id }
        );
        return;
      }
    }
    if (!decisionReceived && this.tasks.get(taskId).status === "review") {
      this.#recordApprovalRequest(
        taskId,
        this.leaderId,
        "reviewer_returned_no_decision",
        { reviewerId: reviewer.id }
      );
    }
  }

  async stopDispatching(): Promise<void> {
    this.#acceptingActions = false;
  }

  #createProposedTask(action: ActionProposal): TaskRecord {
    const taskId = requiredTaskId(action);
    return this.tasks.create({
      id: taskId,
      title: requiredString(action.payload.title, "title"),
      objective: requiredString(action.payload.objective, "objective"),
      ownerEmployeeId: null,
      dependencies: optionalStringArray(action.payload.dependencies, "dependencies"),
      acceptanceCriteria: requiredStringArray(action.payload.acceptanceCriteria),
      status: "draft",
      retryCount: 0,
      reviewLoopCount: 0,
      artifacts: [],
      evidence: []
    });
  }

  async #assignAndSend(action: ActionProposal): Promise<void> {
    const taskId = requiredTaskId(action);
    const assignee = requiredString(action.payload.assignee, "assignee");
    const assigned = this.tasks.assign(taskId, assignee);
    const runningCount = this.tasks.list().filter(
      (task) => task.status === "running"
    ).length;
    if (runningCount >= this.company.limits.maxParallelTasks) {
      this.#recordApprovalRequest(taskId, this.leaderId, "max_parallel_tasks", {
        assignee,
        maxParallelTasks: this.company.limits.maxParallelTasks
      });
      return;
    }

    this.tasks.transition(taskId, "running", assignee);
    this.#startInFlight(taskId);
    await Promise.resolve();
    if (assigned.ownerEmployeeId !== assignee) {
      throw new Error(`task owner mismatch: ${taskId}`);
    }
  }

  async #recordSubmissionAndRequestReview(action: ActionProposal): Promise<void> {
    const taskId = requiredTaskId(action);
    this.tasks.submit(
      taskId,
      action.actorEmployeeId,
      requiredStringArray(action.payload.artifacts),
      requiredStringArray(action.payload.evidence)
    );
    await this.requestReview(taskId);
  }

  async #rejectAndMaybeRequeue(
    taskId: string,
    reviewerId: string,
    findings: string[]
  ): Promise<void> {
    const rejected = this.tasks.reject(taskId, reviewerId, findings);
    if (rejected.status === "blocked") {
      this.#recordApprovalRequest(
        taskId,
        this.leaderId,
        "review_rejection_limit_reached",
        { findings, reviewLoopCount: rejected.reviewLoopCount }
      );
      return;
    }
    const ownerId = rejected.ownerEmployeeId;
    if (ownerId === null) throw new Error(`task has no owner: ${taskId}`);
    this.tasks.transition(taskId, "running", ownerId);
    this.#startInFlight(taskId);
  }

  async #applySupportedControlAction(action: ActionProposal): Promise<void> {
    switch (action.type) {
      case "task.start": {
        const task = this.tasks.get(requiredTaskId(action));
        if (task.ownerEmployeeId === null) throw new Error(`task has no owner: ${task.id}`);
        this.tasks.transition(task.id, "running", task.ownerEmployeeId);
        this.#startInFlight(task.id);
        return;
      }
      case "task.request_review":
        await this.requestReview(requiredTaskId(action));
        return;
      case "task.block":
        this.tasks.transition(requiredTaskId(action), "blocked", action.actorEmployeeId);
        return;
      case "employee.message":
        await this.#routeEmployeeMessage(action);
        return;
      case "user.approval.request":
        this.#recordApprovalRequest(
          action.taskId,
          action.actorEmployeeId,
          action.reason,
          action.payload
        );
        return;
      case "company.complete.request":
        this.#recordEvent(
          "company.completion_requested",
          action.actorEmployeeId,
          action.taskId,
          { ...action.payload, reason: action.reason }
        );
        return;
      case "task.propose":
      case "task.assign":
      case "task.submit":
      case "task.approve":
      case "task.reject":
        throw new Error(`action routed to wrong handler: ${action.type}`);
      default:
        assertNever(action.type);
    }
  }

  async #routeEmployeeMessage(action: ActionProposal): Promise<void> {
    const recipientId = requiredString(action.payload.recipient, "recipient");
    const recipient = this.#employee(recipientId);
    const text = requiredString(action.payload.message, "message");
    this.#recordEvent("employee.message_sent", action.actorEmployeeId, action.taskId, {
      recipient: recipientId,
      message: text
    });
    for await (const event of this.sessions.send(recipient, {
      messageId: randomUUID(),
      employeeId: recipient.id,
      taskId: action.taskId,
      text,
      actionRequest: action
    })) {
      if (event.type === "action.proposed") await this.dispatch(event.action);
    }
  }

  #startInFlight(taskId: string): void {
    let tracked: Promise<void>;
    tracked = this.sendTask(taskId)
      .catch((error: unknown) => {
        this.#recordEvent("task.execution_error", "core", taskId, {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.#inFlight.get(taskId) === tracked) this.#inFlight.delete(taskId);
      });
    this.#inFlight.set(taskId, tracked);
  }

  #taskOwner(task: TaskRecord): EmployeeDefinition {
    if (task.ownerEmployeeId === null) throw new Error(`task has no owner: ${task.id}`);
    return this.#employee(task.ownerEmployeeId);
  }

  #employee(employeeId: string): EmployeeDefinition {
    const employee = this.company.employees.find((item) => item.id === employeeId);
    if (employee === undefined) throw new Error(`unknown employee: ${employeeId}`);
    return employee;
  }

  #taskMessage(task: TaskRecord, employee: EmployeeDefinition): AgentMessage {
    return {
      messageId: randomUUID(),
      employeeId: employee.id,
      taskId: task.id,
      text: [
        task.objective,
        `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`
      ].join("\n"),
      actionRequest: null
    };
  }

  #recordApprovalRequest(
    taskId: string | null,
    actorId: string,
    reason: string,
    payload: Record<string, unknown>
  ): void {
    this.#recordEvent("user.approval.requested", actorId, taskId, {
      ...payload,
      reason
    });
  }

  #recordEvent(
    type: string,
    actorId: string,
    taskId: string | null,
    payload: Record<string, unknown>
  ): void {
    this.store.insertEvent({
      id: randomUUID(),
      type,
      actorId,
      taskId,
      causationEventId: null,
      payload
    });
  }
}
