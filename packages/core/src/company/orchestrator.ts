import { randomUUID } from "node:crypto";
import type {
  ActionProposal,
  AgentEvent,
  AgentMessage,
  CompanyDefinition,
  EmployeeDefinition,
  ReviewTaskContext,
  TaskRecord,
  WritableTaskContext
} from "@agenttown/runtime-contract";
import {
  SessionManager,
  SessionReplacementCleanupError
} from "../agents/session-manager.js";
import { ActionPolicy } from "../policy/action-policy.js";
import { CoreStore } from "../storage/core-store.js";
import { TaskService } from "../tasks/task-service.js";

export interface TaskWorkflow {
  handles(action: ActionProposal): boolean;
  assign(action: ActionProposal): Promise<void>;
  submit(action: ActionProposal): Promise<void>;
  review(action: ActionProposal): Promise<void>;
  taskContext?(
    task: TaskRecord
  ): WritableTaskContext | ReviewTaskContext | null;
}

export interface TaskWorkflowHandlers {
  assign(action: ActionProposal): Promise<void>;
  submit(action: ActionProposal): Promise<void>;
  review(action: ActionProposal): Promise<void>;
}

export interface LeaderDriveOptions {
  /**
   * Enables the autonomous leader drive loop started by `start()`. When
   * omitted the loop is enabled automatically when the company contains any
   * real-agent employee (codex, claude, opencode); fake-only companies keep
   * the legacy externally-injected dispatch behavior.
   */
  driveLeader?: boolean;
  /** Maximum drive turns before the loop records and stops. Defaults to 10. */
  leaderTurnCap?: number;
}

/**
 * Maximum rejected actions a driven Git employee may propose before the
 * drive gives up and records a task execution error. Real agents sometimes
 * mis-propose (e.g. a developer emitting task.propose), so the first
 * rejection re-drives the same message; the cap bounds a persistently
 * misbehaving agent.
 */
const MAX_DRIVE_REJECTED_ACTIONS = 3;

export class FakeTaskWorkflow implements TaskWorkflow {
  constructor(private readonly handlers: TaskWorkflowHandlers) {}

  handles(_action: ActionProposal): boolean {
    return true;
  }

  async assign(action: ActionProposal): Promise<void> {
    await this.handlers.assign(action);
  }

  async submit(action: ActionProposal): Promise<void> {
    await this.handlers.submit(action);
  }

  async review(action: ActionProposal): Promise<void> {
    await this.handlers.review(action);
  }
}

export interface GitTaskWorkflowCoordinator {
  handles(action: ActionProposal): boolean;
  assignTask(action: ActionProposal): Promise<unknown>;
  submitTask(action: ActionProposal): Promise<unknown>;
  recordReview(action: ActionProposal): Promise<unknown>;
  taskContext?(
    task: TaskRecord
  ): WritableTaskContext | ReviewTaskContext | null;
}

export class GitTaskWorkflow implements TaskWorkflow {
  constructor(private readonly coordinator: GitTaskWorkflowCoordinator) {}

  handles(action: ActionProposal): boolean {
    return this.coordinator.handles(action);
  }

  async assign(action: ActionProposal): Promise<void> {
    await this.coordinator.assignTask(action);
  }

  async submit(action: ActionProposal): Promise<void> {
    await this.coordinator.submitTask(action);
  }

  async review(action: ActionProposal): Promise<void> {
    await this.coordinator.recordReview(action);
  }

  taskContext(
    task: TaskRecord
  ): WritableTaskContext | ReviewTaskContext | null {
    return this.coordinator.taskContext?.(task) ?? null;
  }
}

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
  #dispatchEpoch = 0;
  #dispatchController = new AbortController();
  #reviewRecoveryTail: Promise<void> = Promise.resolve();
  readonly #fakeTaskWorkflow: FakeTaskWorkflow;
  #gitTaskWorkflow: TaskWorkflow | undefined;
  readonly #driveLeaderEnabled: boolean;
  readonly #leaderTurnCap: number;
  #leaderDrive: Promise<void> | undefined;

  constructor(
    private readonly companyId: string,
    private readonly company: CompanyDefinition,
    private readonly store: CoreStore,
    private readonly tasks: TaskService,
    private readonly policy: ActionPolicy,
    private readonly sessions: SessionManager,
    private readonly leaderId: string,
    private readonly reviewerId: string,
    gitTaskWorkflow?: TaskWorkflow,
    options: LeaderDriveOptions = {}
  ) {
    this.#gitTaskWorkflow = gitTaskWorkflow;
    this.#driveLeaderEnabled = options.driveLeader
      ?? this.company.employees.some(({ agent }) => agent !== "fake");
    this.#leaderTurnCap = options.leaderTurnCap ?? 10;
    this.#fakeTaskWorkflow = new FakeTaskWorkflow({
      assign: async (action) => {
        await this.#assignAndSend(action);
      },
      submit: async (action) => {
        await this.#recordSubmissionAndRequestReview(action);
      },
      review: async (action) => {
        if (action.type === "task.approve") {
          this.tasks.transition(
            requiredTaskId(action),
            "completed",
            action.actorEmployeeId
          );
          return;
        }
        if (action.type === "task.reject") {
          await this.#rejectAndMaybeRequeue(
            requiredTaskId(action),
            action.actorEmployeeId,
            requiredStringArray(action.payload.findings)
          );
          return;
        }
        throw new Error(`Fake review workflow cannot handle ${action.type}`);
      }
    });
  }

  /**
   * Binds the Git task workflow after construction. The Git coordinator needs
   * the orchestrator's session drive (and the orchestrator needs the workflow),
   * so Core constructs the orchestrator first and attaches the Git workflow as
   * soon as the Git services are wired.
   */
  attachGitWorkflow(workflow: TaskWorkflow): void {
    if (this.#gitTaskWorkflow !== undefined) {
      throw new Error("Git workflow is already attached");
    }
    this.#gitTaskWorkflow = workflow;
  }

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
      if (this.#dispatchController.signal.aborted) {
        this.#dispatchController = new AbortController();
      }
      this.#acceptingActions = true;
      if (this.#driveLeaderEnabled) {
        this.#startLeaderDrive();
      }
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
        await this.#taskWorkflow(action).assign(action);
        return;
      case "task.submit":
        await this.#taskWorkflow(action).submit(
          this.#resolveSubmitTaskId(action)
        );
        return;
      case "task.approve":
        await this.#taskWorkflow(action).review(action);
        return;
      case "task.reject":
        await this.#taskWorkflow(action).review(action);
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

  async sendTask(
    taskId: string,
    epoch = this.#dispatchEpoch,
    signal = this.#dispatchController.signal
  ): Promise<void> {
    this.#assertEpoch(epoch);
    while (true) {
      const task = this.tasks.get(taskId);
      const employee = this.#taskOwner(task);
      let failed = false;

      try {
        for await (const event of this.sessions.send(
          employee,
          this.#taskMessage(task, employee),
          signal
        )) {
          this.#assertEpoch(epoch);
          if (event.type === "action.proposed") {
            try {
              this.#assertProposalTask(event.action, taskId);
              await this.dispatch(event.action);
            } catch (error) {
              if (epoch !== this.#dispatchEpoch) return;
              // A rejected action (e.g. a real developer mis-proposing a new
              // task) is not fatal: keep consuming the same turn so the Agent
              // can correct itself with a valid terminal action. The turn
              // always ends (session.exited), which bounds this loop.
              this.#recordEvent("action.rejected", "core", taskId, {
                actionId: event.action.actionId,
                reason: this.#errorMessage(error)
              });
            }
          } else if (event.type === "adapter.error" || event.type === "session.exited") {
            failed = true;
            break;
          }
        }
      } catch (error) {
        if (epoch !== this.#dispatchEpoch) return;
        failed = true;
        this.#recordEvent("task.execution_error", employee.id, taskId, {
          reason: this.#errorMessage(error)
        });
      }

      if (epoch !== this.#dispatchEpoch) return;
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
        await this.sessions.resumeOne(employee, checkpoint, signal);
        this.#assertEpoch(epoch);
      } catch (resumeError) {
        if (epoch !== this.#dispatchEpoch) return;
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
          await this.sessions.rebuildOne(employee, checkpoint.handoff, signal);
          this.#assertEpoch(epoch);
        } catch (rebuildError) {
          if (epoch !== this.#dispatchEpoch) return;
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

  /**
   * Starts the autonomous leader drive loop fire-and-forget from `start()`.
   * The loop is epoch/abort guarded like every other dispatch loop, so
   * `stopDispatching()` (pause/stop) aborts it at the next checkpoint and the
   * turn cap prevents an unresponsive leader from spinning forever.
   */
  #startLeaderDrive(): void {
    const epoch = this.#dispatchEpoch;
    const signal = this.#dispatchController.signal;
    let tracked: Promise<void>;
    tracked = this.#driveLeader(epoch, signal)
      .catch((error: unknown) => {
        if (epoch !== this.#dispatchEpoch) return;
        this.#recordEvent("task.execution_error", this.leaderId, null, {
          reason: this.#errorMessage(error)
        });
      })
      .finally(() => {
        if (this.#leaderDrive === tracked) this.#leaderDrive = undefined;
      });
    this.#leaderDrive = tracked;
  }

  /**
   * Drives the leader through the mission: turn 0 asks for the first
   * `task.propose`, the next turn asks to assign the created task, and later
   * turns are state driven (nudge an unassigned task, summarize when every
   * task is terminal, otherwise request the next task or completion). Every
   * leader action flows through the normal `dispatch()` routes so the
   * externally injected path (E2E boss) stays untouched. The loop stops on a
   * leader session failure, an epoch change (pause/stop), an unexpected
   * non-propose action that policy rejects, `company.complete.request`, or the
   * turn cap.
   */
  async #driveLeader(epoch: number, signal: AbortSignal): Promise<void> {
    const leader = this.#employee(this.leaderId);
    let createdTaskId: string | null = null;
    let turn = 0;
    let rejectedProposals = 0;
    while (turn < this.#leaderTurnCap) {
      if (epoch !== this.#dispatchEpoch || signal.aborted) return;
      const message = this.#leaderDriveMessage(createdTaskId);
      let sawAction = false;
      let stop = false;
      let resend = false;
      try {
        for await (const event of this.sessions.send(leader, message, signal)) {
          if (epoch !== this.#dispatchEpoch || signal.aborted) return;
          if (event.type === "action.proposed") {
            sawAction = true;
            const outcome = await this.#applyLeaderAction(
              event.action,
              createdTaskId
            );
            if (outcome.kind === "stop") {
              stop = true;
              break;
            }
            if (outcome.kind === "resend") {
              resend = true;
              break;
            }
            if (outcome.taskId !== null) createdTaskId = outcome.taskId;
          } else if (
            event.type === "adapter.error"
            || event.type === "session.exited"
          ) {
            this.#recordEvent("task.execution_error", leader.id, createdTaskId, {
              reason: `leader session ${event.type} while being driven`
            });
            return;
          }
        }
      } catch (error) {
        if (epoch !== this.#dispatchEpoch) return;
        this.#recordEvent("task.execution_error", leader.id, createdTaskId, {
          reason: this.#errorMessage(error)
        });
        return;
      }
      if (epoch !== this.#dispatchEpoch || signal.aborted) return;
      if (stop) return;
      if (resend) {
        rejectedProposals += 1;
        if (rejectedProposals >= 3) {
          this.#recordEvent("task.execution_error", leader.id, createdTaskId, {
            reason: "leader repeated a rejected task.propose"
          });
          return;
        }
        continue;
      }
      rejectedProposals = 0;
      if (!sawAction) return;
      turn += 1;
    }
    this.#recordEvent("task.execution_error", leader.id, createdTaskId, {
      reason: `leader drive loop reached the ${this.#leaderTurnCap} turn cap`
    });
  }

  /**
   * Dispatches one leader-proposed action and reports the loop outcome.
   * `task.propose` is expected on the first turn (its task id becomes the
   * tracked created task), `task.assign` routes to the normal assignment path
   * (which drives the assignee), `company.complete.request` ends the loop, and
   * every other supported action falls back to the existing dispatch routes.
   * A policy-rejected `task.propose` returns "resend" so the loop retries the
   * same prompt a bounded number of times; any other rejected action stops the
   * loop after recording.
   */
  async #applyLeaderAction(
    action: ActionProposal,
    createdTaskId: string | null
  ): Promise<
    | { kind: "dispatched"; taskId: string | null }
    | { kind: "stop"; taskId: null }
    | { kind: "resend"; taskId: null }
  > {
    try {
      await this.dispatch(action);
    } catch (error) {
      this.#recordEvent("action.rejected", "core", action.taskId, {
        actionId: action.actionId,
        reason: this.#errorMessage(error)
      });
      // Any rejected leader action (including a stray task.start or a
      // malformed assign) is retried a bounded number of times instead of
      // killing the drive loop: policy already guards against abuse, and the
      // loop's rejection cap stops a persistently misbehaving leader.
      return { kind: "resend", taskId: null };
    }
    if (action.type === "company.complete.request") {
      return { kind: "stop", taskId: null };
    }
    if (action.type === "task.propose") {
      return { kind: "dispatched", taskId: action.taskId };
    }
    return { kind: "dispatched", taskId: createdTaskId };
  }

  /**
   * Builds the next leader drive message from the current task state: an
   * unassigned (draft) task takes priority for assignment, a fully terminal
   * task set asks for completion or the next task, otherwise the mission
   * prompt asks for the first task or the next one while work is in progress.
   */
  #leaderDriveMessage(createdTaskId: string | null): AgentMessage {
    const leader = this.#employee(this.leaderId);
    const tasks = this.tasks.list();
    const unassigned = tasks.find(({ status }) => status === "draft");
    const allTerminal = tasks.length > 0
      && tasks.every(({ status }) =>
        status === "completed" || status === "blocked"
      );
    let taskId: string | null;
    let text: string;
    if (unassigned !== undefined) {
      taskId = unassigned.id;
      text = [
        `Task ${unassigned.id} has been created.`,
        `Assign it to a developer by emitting a task.assign action with assignee "developer-a" or "developer-b".`
      ].join("\n");
    } else if (allTerminal) {
      taskId = createdTaskId;
      text = [
        "All tasks are completed or blocked.",
        "Emit a company.complete.request to finish the mission, or propose the next task."
      ].join("\n");
    } else if (createdTaskId === null) {
      taskId = null;
      text = [
        `Mission: ${this.company.company.mission}`,
        "Propose the first task by emitting a task.propose action with a title, objective and acceptance criteria."
      ].join("\n");
    } else {
      taskId = createdTaskId;
      text = [
        `Task ${createdTaskId} is in progress.`,
        "Propose the next task, or emit a company.complete.request when the mission is complete."
      ].join("\n");
    }
    return {
      messageId: randomUUID(),
      employeeId: leader.id,
      taskId,
      text,
      actionRequest: null,
      taskContext: null
    };
  }

  async requestReview(
    taskId: string,
    epoch = this.#dispatchEpoch,
    signal = this.#dispatchController.signal
  ): Promise<void> {
    this.#assertEpoch(epoch);
    const reviewer = this.#employee(this.reviewerId);
    let decisionReceived = false;
    for await (const event of this.sessions.send(reviewer, {
      messageId: randomUUID(),
      employeeId: reviewer.id,
      taskId,
      text: `Review task ${taskId} and propose approval or rejection.`,
      actionRequest: null,
      taskContext: this.#gitTaskWorkflow?.taskContext?.(this.tasks.get(taskId))
        ?? null
    }, signal)) {
      this.#assertEpoch(epoch);
      if (event.type === "action.proposed") {
        try {
          if (event.action.type !== "task.approve" && event.action.type !== "task.reject") {
            throw new Error("reviewer must propose task.approve or task.reject");
          }
          this.#assertProposalTask(event.action, taskId);
          await this.dispatch(event.action);
          decisionReceived = true;
        } catch (error) {
          if (epoch !== this.#dispatchEpoch) return;
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
    if (epoch !== this.#dispatchEpoch) return;
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
    this.#dispatchEpoch += 1;
    this.#dispatchController.abort();
  }

  resumeDispatching(): void {
    this.#dispatchController = new AbortController();
    this.#acceptingActions = true;
  }

  recoverWork(): void {
    const tasks = this.tasks.list();
    for (const task of tasks
      .filter(({ status }) => status === "running")
      .slice(0, this.company.limits.maxParallelTasks)) {
      if (!this.#inFlight.has(task.id)) this.#startInFlight(task.id);
    }
    for (const task of tasks.filter(({ status }) => status === "review")) {
      if (this.#inFlight.has(task.id)) continue;
      const epoch = this.#dispatchEpoch;
      const signal = this.#dispatchController.signal;
      const previous = this.#reviewRecoveryTail;
      let tracked: Promise<void>;
      tracked = previous
        .catch(() => undefined)
        .then(async () => {
          this.#assertEpoch(epoch);
          await this.requestReview(task.id, epoch, signal);
        })
        .catch((error: unknown) => {
          if (epoch !== this.#dispatchEpoch) return;
          this.#recordEvent("task.execution_error", "core", task.id, {
            message: this.#errorMessage(error)
          });
        })
        .finally(() => {
          if (this.#inFlight.get(task.id) === tracked) {
            this.#inFlight.delete(task.id);
          }
        });
      this.#reviewRecoveryTail = tracked;
      this.#inFlight.set(task.id, tracked);
    }
  }

  async quiesce(signal: AbortSignal): Promise<boolean> {
    const pending = Promise.allSettled([...this.#inFlight.values()]).then(() => true);
    if (this.#inFlight.size === 0) return true;
    if (signal.aborted) return false;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<false>((resolvePromise) => {
          onAbort = () => resolvePromise(false);
          signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
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
      evidence: [],
      conflictForTaskId: null
    });
  }

  /**
   * Real-agent developers occasionally omit the task id on task.submit.
   * If it is missing, resolve it to the actor's unique running task so the
   * submission is not lost to a strict-id rejection.
   */
  #resolveSubmitTaskId(action: ActionProposal): ActionProposal {
    if (action.taskId !== null) return action;
    const running = this.tasks.list().filter((task) =>
      task.ownerEmployeeId === action.actorEmployeeId && task.status === "running"
    );
    if (running.length !== 1) {
      throw new Error(
        `task.submit requires taskId: ${action.actorEmployeeId} has ${running.length} running tasks`
      );
    }
    return { ...action, taskId: running[0]!.id };
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
        if (this.#gitTaskWorkflow?.handles(action) === true) {
          throw new Error(
            "Git task start requires coordinator assignment with WritableTaskContext"
          );
        }
        const task = this.tasks.get(requiredTaskId(action));
        if (task.ownerEmployeeId === null) throw new Error(`task has no owner: ${task.id}`);
        if (task.ownerEmployeeId !== action.actorEmployeeId) {
          throw new Error("task owner required");
        }
        this.#startReadyTask(task.id, action.actorEmployeeId);
        return;
      }
      case "task.request_review":
        if (this.#gitTaskWorkflow?.handles(action) === true) {
          throw new Error(
            "Git review requires a structured submission through the coordinator"
          );
        }
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
      actionRequest: action,
      taskContext: null
    }, this.#dispatchController.signal)) {
      if (event.type === "action.proposed") await this.dispatch(event.action);
    }
  }

  #startInFlight(taskId: string): void {
    const epoch = this.#dispatchEpoch;
    const signal = this.#dispatchController.signal;
    let tracked: Promise<void>;
    tracked = this.sendTask(taskId, epoch, signal)
      .catch((error: unknown) => {
        if (epoch !== this.#dispatchEpoch) return;
        this.#recordEvent("task.execution_error", "core", taskId, {
          message: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        if (this.#inFlight.get(taskId) === tracked) this.#inFlight.delete(taskId);
      });
    this.#inFlight.set(taskId, tracked);
  }

  #assertEpoch(epoch: number): void {
    if (epoch !== this.#dispatchEpoch) {
      throw new Error("orchestrator dispatch epoch expired");
    }
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
    const taskContext = this.#gitTaskWorkflow?.taskContext?.(task) ?? null;
    const worktreeState =
      taskContext !== null && taskContext.kind === "git_worktree"
        ? taskContext.headCommit === taskContext.baseCommit
          ? `Current worktree state: HEAD is ${taskContext.headCommit} (no task commits yet). If the acceptance criteria are already satisfied by files present in the worktree (e.g. a re-run over previously integrated work), do NOT re-implement: verify, then emit ONE task.submit with the current HEAD commit. Otherwise implement, commit, then submit.`
          : `Current worktree state: HEAD is ${taskContext.headCommit} (ahead of base ${taskContext.baseCommit} — the implementation is already committed). Do NOT re-implement it: verify the existing files against the acceptance criteria, then emit ONE task.submit immediately with payload.submission.headCommit = ${taskContext.headCommit} and the existing commit shas.`
        : null;
    const executionInstruction = employee.agent !== "fake" && employee.role === "developer"
      ? [
          "You are ASSIGNED this task. You are the implementer, not the leader: do NOT propose new tasks.",
          "Use EXACTLY this task's id as the taskId in your task.submit action; do NOT invent a new task id.",
          "Implement the task inside the git worktree given in the task context (workspaceRoot): write the required files there, run git add and git commit inside that worktree, then emit ONE task.submit action with payload.submission = { schemaVersion: 1, headCommit, commits, changeSummary, validationCommandIds: [\"git-clean\"], suggestedValidationCommands: [], reportedResults: [], knownRisks: [] } (headCommit = `git rev-parse HEAD` in the worktree; commits = your commit shas from `git log --format=%H`, oldest first).",
          ...(worktreeState === null ? [] : [worktreeState])
        ]
      : [];
    return {
      messageId: randomUUID(),
      employeeId: employee.id,
      taskId: task.id,
      text: [
        ...executionInstruction,
        task.objective,
        `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`,
        ...(taskContext === null
          ? []
          : [`Task context: ${JSON.stringify(taskContext)}`])
      ].join("\n"),
      actionRequest: null,
      taskContext
    };
  }

  /**
   * Drives one Agent message for the Git workflow (assignment or review
   * handoff) and dispatches any structured action the Agent proposes. The
   * caller is responsible for not awaiting this loop inside a dispatch path:
   * Git assignments are background-driven so the task stays observable in the
   * `running` state until the Agent finishes its work.
   *
   * Rejected actions (policy violations, task-id mismatches, malformed
   * payloads) do not kill the drive: the same message is re-sent so the Agent
   * gets a chance to correct itself. Only repeated rejections (bounded),
   * session failure, or a task that left the running state end the drive.
   */
  async driveGitMessage(
    employeeId: string,
    message: AgentMessage
  ): Promise<void> {
    const employee = this.#employee(employeeId);
    const epoch = this.#dispatchEpoch;
    const signal = this.#dispatchController.signal;
    let rejectedActions = 0;
    while (true) {
      if (epoch !== this.#dispatchEpoch || signal.aborted) return;
      if (message.taskId !== null) {
        const task = this.tasks.get(message.taskId);
        if (task === undefined) return;
        // The Git coordinator sends the task message before the running
        // transition (a failed delivery leaves the task `ready` for retry),
        // so the first drive happens while the task is still `ready` with
        // the employee already assigned. Allow ready+running; anything else
        // (draft without owner, terminal states, ownership change) stops
        // the drive.
        if (task.ownerEmployeeId !== employeeId) return;
        if (task.status !== "ready" && task.status !== "running") return;
      }
      let sawAction = false;
      try {
        for await (const event of this.sessions.send(employee, message, signal)) {
          if (epoch !== this.#dispatchEpoch || signal.aborted) return;
          if (event.type === "action.proposed") {
            sawAction = true;
            try {
              if (message.taskId !== null) {
                this.#assertProposalTask(event.action, message.taskId);
              }
              await this.dispatch(event.action);
            } catch (error) {
              if (epoch !== this.#dispatchEpoch) return;
              rejectedActions += 1;
              this.#recordEvent("action.rejected", "core", message.taskId, {
                actionId: event.action.actionId,
                reason: this.#errorMessage(error)
              });
              if (rejectedActions >= MAX_DRIVE_REJECTED_ACTIONS) {
                this.#recordEvent(
                  "task.execution_error",
                  employee.id,
                  message.taskId,
                  { reason: `agent repeated rejected actions (${rejectedActions})` }
                );
                return;
              }
              break;
            }
          } else if (
            event.type === "adapter.error"
            || event.type === "session.exited"
          ) {
            return;
          }
        }
      } catch (error) {
        if (epoch !== this.#dispatchEpoch) return;
        this.#recordEvent("task.execution_error", employee.id, message.taskId, {
          reason: this.#errorMessage(error)
        });
        return;
      }
      if (!sawAction || rejectedActions === 0) return;
    }
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

  #taskWorkflow(action: ActionProposal): TaskWorkflow {
    return this.#gitTaskWorkflow?.handles(action) === true
      ? this.#gitTaskWorkflow
      : this.#fakeTaskWorkflow;
  }
}
