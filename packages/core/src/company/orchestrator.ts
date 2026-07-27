import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentEvent,
  AgentMessage,
  CompanyDefinition,
  EmployeeDefinition,
  TaskRecord
} from "@agenttown/runtime-contract";
import {
  SessionManager,
  SessionReplacementCleanupError
} from "../agents/session-manager.js";
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

      try {
        for await (const event of this.sessions.send(
          employee,
          this.#taskMessage(task, employee)
        )) {
          if (event.type === "action.proposed") {
            try {
              this.#assertProposalTask(event.action, taskId);
              await this.dispatch(event.action);
            } catch (error) {
              failed = true;
              this.#recordEvent("action.rejected", "core", taskId, {
                actionId: event.action.actionId,
                reason: this.#errorMessage(error)
              });
              break;
            }
          } else if (event.type === "adapter.error" || event.type === "session.exited") {
            failed = true;
            break;
          }
        }
      } catch (error) {
        failed = true;
        this.#recordEvent("task.execution_error", employee.id, taskId, {
          reason: this.#errorMessage(error)
        });
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
      if (!this.#hasRunningCapacity()) {
        this.#recordCapacityApproval(taskId, employee.id);
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
      } catch (resumeError) {
        if (resumeError instanceof SessionReplacementCleanupError) {
          this.#recordApprovalRequest(
            taskId,
            this.leaderId,
            "session_replacement_cleanup_failed",
            { employeeId: employee.id, error: this.#errorMessage(resumeError) }
          );
          return;
        }
        try {
          await this.sessions.rebuildOne(employee, checkpoint.handoff);
        } catch (rebuildError) {
          this.#recordApprovalRequest(
            taskId,
            this.leaderId,
            "session_recovery_failed",
            { employeeId: employee.id, error: this.#errorMessage(rebuildError) }
          );
          return;
        }
      }
      if (!this.#hasRunningCapacity()) {
        this.#recordCapacityApproval(taskId, employee.id);
        return;
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
        try {
          if (event.action.type !== "task.approve" && event.action.type !== "task.reject") {
            throw new Error("reviewer must propose task.approve or task.reject");
          }
          this.#assertProposalTask(event.action, taskId);
          await this.dispatch(event.action);
          decisionReceived = true;
        } catch (error) {
          this.#recordApprovalRequest(
            taskId,
            this.leaderId,
            "reviewer_invalid_decision",
            {
              reviewerId: reviewer.id,
              decisionActionId: event.action.actionId,
              error: this.#errorMessage(error)
            }
          );
          return;
        }
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
    if (assigned.ownerEmployeeId !== assignee) {
      throw new Error(`task owner mismatch: ${taskId}`);
    }
    this.#startReadyTask(taskId, assignee);
    await Promise.resolve();
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
    this.#startReadyTask(taskId, ownerId);
  }

  async #applySupportedControlAction(action: ActionProposal): Promise<void> {
    switch (action.type) {
      case "task.start": {
        const task = this.tasks.get(requiredTaskId(action));
        if (task.ownerEmployeeId === null) throw new Error(`task has no owner: ${task.id}`);
        if (task.ownerEmployeeId !== action.actorEmployeeId) {
          throw new Error("task owner required");
        }
        this.#startReadyTask(task.id, action.actorEmployeeId);
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

  #startReadyTask(taskId: string, actorId: string): boolean {
    if (!this.#hasRunningCapacity()) {
      this.#recordCapacityApproval(taskId, actorId);
      return false;
    }
    this.tasks.transition(taskId, "running", actorId);
    this.#startInFlight(taskId);
    return true;
  }

  #hasRunningCapacity(): boolean {
    return this.tasks.list().filter(
      (task) => task.status === "running"
    ).length < this.company.limits.maxParallelTasks;
  }

  #recordCapacityApproval(taskId: string, actorId: string): void {
    this.#recordApprovalRequest(taskId, this.leaderId, "max_parallel_tasks", {
      assignee: actorId,
      maxParallelTasks: this.company.limits.maxParallelTasks,
      operation: `start task ${taskId}`,
      impact: "Starting this task would exceed the configured parallel task limit.",
      alternatives: ["wait_for_capacity", "raise_parallel_limit"],
      consequenceOfNonApproval: "The task remains ready until capacity becomes available.",
      question: `How should AgentTown handle ${taskId} while all task slots are occupied?`,
      options: ["wait_for_capacity", "raise_parallel_limit"]
    });
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
    const options = this.#nonEmptyStrings(payload.options)
      ?? ["approve_operation", "choose_alternative"];
    const alternatives = this.#nonEmptyStrings(payload.alternatives) ?? [...options];
    this.#recordEvent("user.approval.requested", actorId, taskId, {
      ...payload,
      reason,
      operation: this.#nonEmptyString(payload.operation)
        ?? `resolve ${reason}${taskId === null ? "" : ` for ${taskId}`}`,
      impact: this.#nonEmptyString(payload.impact)
        ?? "AgentTown cannot safely continue this operation without a user decision.",
      alternatives,
      consequenceOfNonApproval: this.#nonEmptyString(payload.consequenceOfNonApproval)
        ?? "Work remains paused or blocked at this decision point.",
      question: this.#nonEmptyString(payload.question)
        ?? `How should AgentTown resolve ${reason.replaceAll("_", " ")}?`,
      options
    });
  }

  #assertProposalTask(action: ActionProposal, expectedTaskId: string): void {
    if (action.taskId !== expectedTaskId) {
      throw new Error(
        `proposal task mismatch: expected ${expectedTaskId}, received ${String(action.taskId)}`
      );
    }
  }

  #nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  #nonEmptyStrings(value: unknown): string[] | null {
    if (
      !Array.isArray(value)
      || value.length === 0
      || value.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      return null;
    }
    return [...value] as string[];
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
