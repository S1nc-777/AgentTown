import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  CompanyCheckpoint,
  CompanyDefinition,
  EmployeeDefinition,
  GitCheckpoint,
  ReconciliationResult,
  RecoveryDecision,
  SessionCheckpoint,
  SessionHandle,
  TaskRecord
} from "@agenttown/runtime-contract";
import {
  SessionManager,
  type InterruptOutcome,
  type StopOutcome
} from "../agents/session-manager.js";
import { CompanyOrchestrator } from "../company/orchestrator.js";
import { CoreStore, type NewEvent, type StoredCheckpoint } from "../storage/core-store.js";

export type PauseReason = CompanyCheckpoint["reason"];
export interface RecoveryResult {
  decisions: RecoveryDecision[];
}

export interface CheckpointServiceOptions {
  companyId: string;
  company: CompanyDefinition;
  store: CoreStore;
  orchestrator: Pick<
    CompanyOrchestrator,
    "stopDispatching" | "resumeDispatching" | "recoverWork" | "quiesce"
  >;
  sessions: Pick<
    SessionManager,
    | "interruptAll"
    | "stopAll"
    | "stopAllBounded"
    | "cleanupOwnershipSnapshot"
    | "cancelPendingReplacements"
    | "resumeOne"
    | "rebuildOne"
  >;
  adapterFor: (agentName: string) => AgentAdapter;
  scenarios?: Readonly<Record<string, string>>;
  pauseTimeoutMs?: number;
  gitLifecycle?: {
    abortValidations(signal: AbortSignal, deadlineAt: number): Promise<void>;
    settleIntegrationIntent(signal: AbortSignal, deadlineAt: number): Promise<void>;
    snapshot(): Promise<GitCheckpoint | null>;
    reconcile(runId: string): Promise<ReconciliationResult>;
    /**
     * Reactivates a git run that was paused by an aborted pause attempt, so
     * the company can keep dispatching Git work after a failed pause.
     */
    reactivate(): Promise<void>;
  };
}

export class RecoveryBlockedError extends Error {
  constructor(readonly employeeId: string, cause: unknown) {
    super(`company recovery blocked at employee ${employeeId}`, { cause });
    this.name = "RecoveryBlockedError";
  }
}

export class PauseFailedError extends Error {
  constructor(readonly outcomes: readonly StopOutcome[]) {
    super(`company pause failed because sessions remain live: ${JSON.stringify(outcomes)}`);
    this.name = "PauseFailedError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a well-formed non-empty string`);
  }
  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readString(value, label);
}

function readHandoff(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("checkpoint handoff must be well-formed text");
  }
  return value;
}

function parseHandle(value: unknown): SessionHandle {
  if (!isRecord(value)) throw new TypeError("checkpoint handle must be an object");
  return {
    employeeId: readString(value.employeeId, "checkpoint handle employeeId"),
    adapter: readString(value.adapter, "checkpoint handle adapter"),
    internalSessionId: readString(value.internalSessionId, "checkpoint internalSessionId"),
    nativeSessionId: readNullableString(value.nativeSessionId, "checkpoint nativeSessionId")
  };
}

function parseGitCheckpoint(value: unknown): GitCheckpoint | null {
  if (value === null) return null;
  if (value === undefined) throw new TypeError("checkpoint git is required");
  if (!isRecord(value)) throw new TypeError("checkpoint git must be an object or null");
  if (!Array.isArray(value.workspaces)
    || !Array.isArray(value.activeSubmissionRevisions)
    || !Array.isArray(value.integrationAttemptIds)) {
    throw new TypeError("checkpoint git collections are invalid");
  }
  const statuses = new Set([
    "active", "paused", "completed", "removing", "missing", "tampered"
  ]);
  return {
    runId: readString(value.runId, "checkpoint git runId"),
    integrationRef: readString(value.integrationRef, "checkpoint git integrationRef"),
    integrationCommit: readString(value.integrationCommit, "checkpoint git integrationCommit"),
    workspaces: value.workspaces.map((raw) => {
      if (!isRecord(raw) || !statuses.has(raw.status as string)) {
        throw new TypeError("checkpoint git workspace is invalid");
      }
      return {
        workspaceId: readString(raw.workspaceId, "checkpoint git workspaceId"),
        branchRef: readString(raw.branchRef, "checkpoint git workspace branchRef"),
        headCommit: readString(raw.headCommit, "checkpoint git workspace headCommit"),
        status: raw.status as GitCheckpoint["workspaces"][number]["status"]
      };
    }),
    activeSubmissionRevisions: value.activeSubmissionRevisions.map((raw) => {
      if (!isRecord(raw) || !Number.isSafeInteger(raw.revision)
        || Number(raw.revision) < 1) {
        throw new TypeError("checkpoint git submission revision is invalid");
      }
      return {
        taskId: readString(raw.taskId, "checkpoint git submission taskId"),
        revision: Number(raw.revision)
      };
    }),
    integrationAttemptIds: value.integrationAttemptIds.map((raw) =>
      readString(raw, "checkpoint git integrationAttemptId"))
  };
}

export function parseCompanyCheckpoint(value: unknown): CompanyCheckpoint {
  if (!isRecord(value)) throw new TypeError("checkpoint payload must be an object");
  const reason = value.reason;
  if (
    reason !== "user_requested"
    && reason !== "last_client_exited"
    && reason !== "shutdown"
  ) {
    throw new TypeError("checkpoint reason is invalid");
  }
  if (!Number.isSafeInteger(value.lastEventSequence) || Number(value.lastEventSequence) < 0) {
    throw new TypeError("checkpoint lastEventSequence must be a non-negative integer");
  }
  if (!Array.isArray(value.sessions)) throw new TypeError("checkpoint sessions must be an array");
  return {
    companyId: readString(value.companyId, "checkpoint companyId"),
    reason,
    lastEventSequence: Number(value.lastEventSequence),
    git: parseGitCheckpoint(value.git),
    sessions: value.sessions.map((raw): SessionCheckpoint => {
      if (!isRecord(raw)) throw new TypeError("checkpoint session must be an object");
      const employeeId = readString(raw.employeeId, "checkpoint session employeeId");
      const handle = parseHandle(raw.handle);
      if (handle.employeeId !== employeeId) {
        throw new TypeError(`checkpoint handle employee mismatch: ${employeeId}`);
      }
      return {
        employeeId,
        handle,
        activeTaskId: readNullableString(raw.activeTaskId, "checkpoint activeTaskId"),
        handoff: readHandoff(raw.handoff)
      };
    })
  };
}

interface ActiveOperation {
  kind: "pause" | "stop" | "recover";
  promise: Promise<unknown>;
}

interface Deadline {
  at: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export class CheckpointService {
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #store: CoreStore;
  readonly #orchestrator: CheckpointServiceOptions["orchestrator"];
  readonly #sessions: CheckpointServiceOptions["sessions"];
  readonly #adapterFor: CheckpointServiceOptions["adapterFor"];
  readonly #scenarios: Readonly<Record<string, string>>;
  readonly #pauseTimeoutMs: number;
  readonly #gitLifecycle: CheckpointServiceOptions["gitLifecycle"];
  #operation: ActiveOperation | null = null;

  constructor(options: CheckpointServiceOptions) {
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#store = options.store;
    this.#orchestrator = options.orchestrator;
    this.#sessions = options.sessions;
    this.#adapterFor = options.adapterFor;
    this.#scenarios = options.scenarios ?? {};
    this.#pauseTimeoutMs = options.pauseTimeoutMs ?? 10_000;
    this.#gitLifecycle = options.gitLifecycle;
    if (!Number.isSafeInteger(this.#pauseTimeoutMs) || this.#pauseTimeoutMs <= 0) {
      throw new RangeError("pauseTimeoutMs must be a positive integer");
    }
  }

  pause(reason: PauseReason): Promise<CompanyCheckpoint> {
    if (this.#operation !== null) {
      if (this.#operation.kind !== "pause") {
        return Promise.reject(new Error("company lifecycle recovery is in progress"));
      }
      return this.#operation.promise as Promise<CompanyCheckpoint>;
    }
    const existing = this.#existingPausedCheckpoint();
    if (existing !== null) return Promise.resolve(existing);
    return this.#runOperation("pause", () => this.#pause(reason));
  }

  stop(): Promise<void> {
    if (this.#operation !== null) {
      if (this.#operation.kind !== "stop") {
        return Promise.reject(new Error("company lifecycle operation is in progress"));
      }
      return this.#operation.promise as Promise<void>;
    }
    if (this.#store.getCompany(this.#companyId)?.status === "stopped") {
      return Promise.resolve();
    }
    return this.#runOperation("stop", async () => {
      await this.#suspend("shutdown", "stopped");
    });
  }

  recoverLatest(): Promise<RecoveryResult> {
    if (this.#operation !== null) {
      if (this.#operation.kind !== "recover") {
        return Promise.reject(new Error("company lifecycle pause is in progress"));
      }
      return this.#operation.promise as Promise<RecoveryResult>;
    }
    const persistedStatus = this.#store.getCompany(this.#companyId)?.status;
    if (persistedStatus !== "paused") {
      return Promise.reject(new Error(
        `company is not eligible for recovery: ${persistedStatus ?? "missing"}`
      ));
    }
    return this.#runOperation("recover", async () => {
      const stored = this.#store.latestCheckpoint(this.#companyId);
      if (stored === null) {
        return this.#blockInvalidRecovery("checkpoint", new Error("checkpoint not found"));
      }
      let checkpoint: CompanyCheckpoint;
      try {
        checkpoint = this.#checkpointFromStored(stored);
        this.#validateCheckpoint(checkpoint, this.#company);
      } catch (error) {
        return this.#blockInvalidRecovery("checkpoint", error);
      }
      return this.#recover(checkpoint, this.#company);
    });
  }

  recover(
    checkpoint: CompanyCheckpoint,
    company: CompanyDefinition = this.#company
  ): Promise<RecoveryResult> {
    if (this.#operation !== null) {
      if (this.#operation.kind !== "recover") {
        return Promise.reject(new Error("company lifecycle pause is in progress"));
      }
      return this.#operation.promise as Promise<RecoveryResult>;
    }
    return this.#runOperation("recover", async () => {
      try {
        this.#validateCheckpoint(checkpoint, company);
      } catch (error) {
        return this.#blockInvalidRecovery("checkpoint", error);
      }
      return this.#recover(checkpoint, company);
    });
  }

  async #pause(reason: PauseReason): Promise<CompanyCheckpoint> {
    return this.#suspend(reason, "paused");
  }

  async #suspend(
    reason: PauseReason,
    terminalStatus: "paused" | "stopped"
  ): Promise<CompanyCheckpoint> {
    const deadline = this.#deadline(this.#pauseTimeoutMs);
    try {
      await this.#orchestrator.stopDispatching();
      const transitioningStatus = terminalStatus === "paused" ? "pausing" : "stopping";
      const transitioningEvent = terminalStatus === "paused"
        ? "company.pausing"
        : "company.stopping";
      this.#store.commitCompanyStatusWithEvents(this.#companyId, transitioningStatus, [
        this.#event(transitioningEvent, "core", null, { reason })
      ]);
      let git: GitCheckpoint | null = null;
      if (this.#gitLifecycle !== undefined) {
        await this.#gitLifecycle.abortValidations(deadline.controller.signal, deadline.at);
        await this.#gitLifecycle.settleIntegrationIntent(deadline.controller.signal, deadline.at);
        git = await this.#gitLifecycle.snapshot();
      }
      const checkpoint = this.#buildCheckpoint(reason, git);
      const stored: StoredCheckpoint = {
        id: randomUUID(),
        companyId: this.#companyId,
        createdAt: new Date().toISOString(),
        payload: checkpoint as unknown as Record<string, unknown>
      };
      const checkpointEvent = this.#event("company.checkpointed", "core", null, {
        reason,
        lastEventSequence: checkpoint.lastEventSequence,
        sessionCount: checkpoint.sessions.length
      });
      const terminalEvent = this.#event(
        terminalStatus === "paused" ? "company.paused" : "company.stopped",
        "core",
        null,
        { reason }
      );
      if (terminalStatus === "paused") {
        this.#store.commitPauseFacts(stored, checkpointEvent, terminalEvent);
      } else {
        this.#store.commitSuspensionFacts(
          stored,
          checkpointEvent,
          terminalStatus,
          terminalEvent
        );
      }
      const interruptSignal = this.#phaseSignal(
        deadline,
        Math.max(1, Math.floor(this.#remaining(deadline) * 0.3))
      );
      const interruptOutcomes = await this.#sessions.interruptAll(interruptSignal.signal);
      interruptSignal.dispose();
      this.#recordInterruptOutcomes(interruptOutcomes);

      const quiesceSignal = this.#phaseSignal(
        deadline,
        Math.max(1, Math.floor(this.#remaining(deadline) * 0.3))
      );
      const quiesced = await this.#orchestrator.quiesce(quiesceSignal.signal);
      quiesceSignal.dispose();
      const pendingReplacements = this.#sessions.cleanupOwnershipSnapshot().owners
        .filter(({ kind }) => kind === "pending_replacement");
      if (!quiesced || pendingReplacements.length > 0) {
        this.#store.insertEvent(this.#event("company.pause_timeout", "core", null, {
          phase: pendingReplacements.length > 0 ? "pending_replacement" : "quiesce",
          timeoutMs: this.#pauseTimeoutMs,
          pendingEmployees: pendingReplacements.map(({ employeeId }) => employeeId)
        }));
      }

      const failed = await this.#cleanupWithinDeadline(deadline);
      if (failed.length > 0) {
        this.#commitSuspensionFailure(
          failed,
          terminalStatus,
          "cleanup_failed"
        );
        throw new PauseFailedError(failed);
      }
      return checkpoint;
    } catch (error) {
      if (error instanceof PauseFailedError) throw error;
      const cleanup = await this.#cleanupWithinDeadline(deadline);
      this.#commitSuspensionFailure(
        cleanup,
        terminalStatus,
        cleanup.length === 0 ? "pause_failed" : "cleanup_failed",
        error
      );
      // The git run was paused by snapshot() before the failure; reactivate
      // it so the company can keep dispatching Git work after the failed
      // pause. A reactivation failure is secondary to the pause failure.
      if (this.#gitLifecycle !== undefined) {
        await this.#gitLifecycle.reactivate().catch(() => undefined);
      }
      throw error;
    } finally {
      clearTimeout(deadline.timer);
      deadline.controller.abort();
    }
  }

  async #recover(
    checkpoint: CompanyCheckpoint,
    company: CompanyDefinition
  ): Promise<RecoveryResult> {
    const companyFact = this.#store.getCompany(this.#companyId);
    if (companyFact?.status !== "paused") {
      throw new Error(`company is not eligible for recovery: ${companyFact?.status ?? "missing"}`);
    }
    await this.#orchestrator.stopDispatching();
    if (checkpoint.git !== null) {
      if (this.#gitLifecycle === undefined) {
        throw new Error("Git reconciliation service is required");
      }
      const reconciliation = await this.#gitLifecycle.reconcile(checkpoint.git.runId);
      if (reconciliation.classification === "tampered"
        || reconciliation.classification === "missing") {
        throw new Error(
          `Git reconciliation blocked: ${JSON.stringify(reconciliation.discrepancies)}`
        );
      }
    }
    this.#store.commitCompanyStatusWithEvents(this.#companyId, "starting", [
      this.#event("company.starting", "core", null, {
        checkpointSequence: checkpoint.lastEventSequence
      })
    ]);
    const decisions: RecoveryDecision[] = [];
    const decisionEvents: NewEvent[] = [];
    const attemptController = new AbortController();
    let currentEmployeeId = "unknown";
    try {
      for (const employee of company.employees) {
        currentEmployeeId = employee.id;
        const session = checkpoint.sessions.find(({ employeeId }) => employeeId === employee.id);
        if (session === undefined) throw new Error(`checkpoint session missing: ${employee.id}`);
        const capabilities = await this.#adapterFor(employee.agent).capabilities();
        const native = capabilities.nativeResume === "supported"
          && session.handle.nativeSessionId !== null;
        const handle = native
          ? await this.#sessions.resumeOne(
              employee,
              session,
              attemptController.signal,
              this.#scenarios[employee.id] ?? "idle"
            )
          : await this.#sessions.rebuildOne(
              employee,
              session.handoff,
              attemptController.signal,
              this.#scenarios[employee.id] ?? "idle"
            );
        const decision: RecoveryDecision = {
          employeeId: employee.id,
          mode: native ? "native" : "rebuilt"
        };
        decisions.push(decision);
        decisionEvents.push(this.#event(
          native ? "session.recovered" : "session.rebuilt",
          employee.id,
          session.activeTaskId,
          {
            mode: decision.mode,
            previousNativeSessionId: session.handle.nativeSessionId,
            nativeSessionId: handle.nativeSessionId,
            activeTaskId: session.activeTaskId,
            handoff: session.handoff
          }
        ));
      }
      this.#store.commitCompanyStatusWithEvents(this.#companyId, "running", [
        ...decisionEvents,
        this.#event("company.recovered", "core", null, { decisions })
      ]);
      this.#orchestrator.resumeDispatching();
      this.#orchestrator.recoverWork();
      attemptController.abort();
      return { decisions };
    } catch (error) {
      attemptController.abort();
      const cleanupDeadline = this.#deadline(this.#pauseTimeoutMs);
      const gracefulSignal = this.#signalUntil(
        Math.max(Date.now(), cleanupDeadline.at - Math.floor(this.#pauseTimeoutMs * 0.5))
      );
      const graceful = await this.#sessions.stopAllBounded(
        gracefulSignal.signal,
        false,
        cleanupDeadline.at
      );
      gracefulSignal.dispose();
      const cleanupOutcomes = graceful.some(({ status }) => status !== "stopped")
        ? await this.#sessions.stopAllBounded(
            cleanupDeadline.controller.signal,
            true,
            cleanupDeadline.at
          )
        : graceful;
      clearTimeout(cleanupDeadline.timer);
      cleanupDeadline.controller.abort();
      const cleanupFailures = cleanupOutcomes.filter(({ status }) => status !== "stopped");
      const cleanupError = cleanupFailures.length === 0
        ? undefined
        : new Error(`recovery cleanup incomplete: ${JSON.stringify(cleanupFailures)}`);
      this.#commitRecoveryBlocked(currentEmployeeId, error, cleanupError, false);
      throw new RecoveryBlockedError(currentEmployeeId, error);
    }
  }

  #recordInterruptOutcomes(outcomes: readonly InterruptOutcome[]): void {
    for (const outcome of outcomes) {
      if (outcome.status === "interrupted") continue;
      this.#store.insertEvent(this.#event(
        outcome.status === "aborted" ? "company.pause_timeout" : "session.interrupt_failed",
        outcome.employeeId,
        null,
        {
          employeeId: outcome.employeeId,
          status: outcome.status,
          error: outcome.error
        }
      ));
    }
  }

  #commitSuspensionFailure(
    outcomes: readonly StopOutcome[],
    terminalStatus: "paused" | "stopped",
    approvalReason: "pause_failed" | "cleanup_failed",
    cause?: unknown
  ): void {
    const stopping = terminalStatus === "stopped";
    this.#store.commitCompanyStatusWithEvents(this.#companyId, "blocked", [
      ...outcomes.map((outcome) => this.#event(
        "session.stop_failed",
        outcome.employeeId,
        null,
        {
          employeeId: outcome.employeeId,
          status: outcome.status,
          error: outcome.error
        }
      )),
      this.#event(
        stopping ? "company.stop_failed" : "company.pause_failed",
        "core",
        null,
        {
        employees: outcomes.map(({ employeeId }) => employeeId),
        error: cause === undefined ? null : errorMessage(cause)
        }
      ),
      stopping
        ? this.#stopApprovalEvent(
            approvalReason === "cleanup_failed"
              ? "stop_cleanup_failed"
              : "stop_failed",
            { employees: outcomes.map(({ employeeId }) => employeeId) }
          )
        : this.#pauseApprovalEvent(approvalReason, {
            employees: outcomes.map(({ employeeId }) => employeeId)
          })
    ]);
  }

  #commitRecoveryBlocked(
    employeeId: string,
    error: unknown,
    cleanupError?: unknown,
    invalidCheckpoint = false
  ): void {
    this.#store.commitCompanyStatusWithEvents(this.#companyId, "blocked", [
      this.#event("company.recovery_blocked", "core", null, {
        employeeId,
        error: errorMessage(error),
        cleanupError: cleanupError === undefined ? null : errorMessage(cleanupError)
      }),
      invalidCheckpoint
        ? this.#invalidCheckpointApproval(error)
        : this.#recoveryApproval(
            cleanupError === undefined ? "recovery_failed" : "cleanup_failed",
            employeeId,
            error
          )
    ]);
  }

  #blockInvalidRecovery(employeeId: string, error: unknown): never {
    this.#commitRecoveryBlocked(employeeId, error, undefined, true);
    throw new RecoveryBlockedError(employeeId, error);
  }

  #existingPausedCheckpoint(): CompanyCheckpoint | null {
    if (this.#store.getCompany(this.#companyId)?.status !== "paused") return null;
    const stored = this.#store.latestCheckpoint(this.#companyId);
    if (stored === null) return null;
    const checkpoint = this.#checkpointFromStored(stored);
    this.#validateCheckpoint(checkpoint, this.#company);
    return checkpoint;
  }

  #buildCheckpoint(reason: PauseReason, git: GitCheckpoint | null): CompanyCheckpoint {
    const tasks = this.#store.listTasks(this.#companyId);
    const sessions = new Map(
      this.#store.listSessions(this.#companyId).map((session) => [session.employeeId, session])
    );
    return {
      companyId: this.#companyId,
      reason,
      lastEventSequence: this.#store.getLatestEventSequence(),
      git,
      sessions: this.#company.employees.map((employee) => {
        const session = sessions.get(employee.id);
        if (session === undefined) throw new Error(`active session fact missing: ${employee.id}`);
        const task = tasks.find((candidate) =>
          candidate.ownerEmployeeId === employee.id
          && (candidate.status === "running" || candidate.status === "review")
        );
        return {
          employeeId: employee.id,
          handle: session.handle,
          activeTaskId: task?.id ?? null,
          handoff: this.#handoff(employee, task)
        };
      })
    };
  }

  #handoff(employee: EmployeeDefinition, task: TaskRecord | undefined): string {
    if (task === undefined) {
      return `Resume ${employee.role} duties for ${this.#company.company.name}; no active task.`;
    }
    return [
      `Continue task ${task.id}: ${task.objective}`,
      `Acceptance criteria: ${task.acceptanceCriteria.join("; ")}`
    ].join("\n");
  }

  #validateCheckpoint(
    checkpoint: CompanyCheckpoint,
    company: CompanyDefinition
  ): void {
    if (checkpoint.companyId !== this.#companyId) {
      throw new Error(`checkpoint company mismatch: ${checkpoint.companyId}`);
    }
    if (checkpoint.git !== null) {
      const workspaceIds = checkpoint.git.workspaces.map(({ workspaceId }) => workspaceId);
      const submissionTasks = checkpoint.git.activeSubmissionRevisions
        .map(({ taskId }) => taskId);
      if (new Set(workspaceIds).size !== workspaceIds.length
        || new Set(submissionTasks).size !== submissionTasks.length
        || new Set(checkpoint.git.integrationAttemptIds).size
          !== checkpoint.git.integrationAttemptIds.length) {
        throw new Error("checkpoint Git identities must be unique");
      }
      const run = this.#store.getGitRun(checkpoint.git.runId);
      const workspaces = this.#store.listGitWorkspaces(checkpoint.git.runId).map(
        ({ workspaceId, branchRef, headCommit, status }) => ({
          workspaceId,
          branchRef,
          headCommit,
          status
        })
      );
      const submissions = new Map<string, number>();
      for (const record of this.#store.listGitSubmissions(checkpoint.git.runId)) {
        if (record.status === "integrated" || record.status === "superseded") continue;
        submissions.set(
          record.taskId,
          Math.max(record.revision, submissions.get(record.taskId) ?? 0)
        );
      }
      const activeSubmissionRevisions = [...submissions]
        .map(([taskId, revision]) => ({ taskId, revision }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId, "en"));
      const integrationAttemptIds = this.#store
        .listIntegrationAttempts(checkpoint.git.runId)
        .filter(({ status }) => status === "prepared")
        .map(({ attemptId }) => attemptId)
        .sort();
      if (run === null
        || run.companyId !== this.#companyId
        || run.integrationRef !== checkpoint.git.integrationRef
        || run.integrationCommit !== checkpoint.git.integrationCommit
        || JSON.stringify(workspaces) !== JSON.stringify(checkpoint.git.workspaces)
        || JSON.stringify(activeSubmissionRevisions)
          !== JSON.stringify(checkpoint.git.activeSubmissionRevisions)
        || JSON.stringify(integrationAttemptIds)
          !== JSON.stringify(checkpoint.git.integrationAttemptIds)) {
        throw new Error("checkpoint Git facts do not match durable state");
      }
    }
    const expected = company.employees.map(({ id }) => id);
    const actual = checkpoint.sessions.map(({ employeeId }) => employeeId);
    if (
      actual.length !== expected.length
      || new Set(actual).size !== actual.length
      || expected.some((id) => !actual.includes(id))
    ) {
      throw new Error("checkpoint employee roster mismatch");
    }
    const internalIds = new Set<string>();
    const nativeIds = new Set<string>();
    for (const employee of company.employees) {
      const session = checkpoint.sessions.find(({ employeeId }) => employeeId === employee.id);
      if (session === undefined) throw new Error(`checkpoint session missing: ${employee.id}`);
      if (session.handle.employeeId !== employee.id) {
        throw new Error(`checkpoint handle employee mismatch: ${employee.id}`);
      }
      if (session.handle.adapter !== employee.agent) {
        throw new Error(`checkpoint adapter mismatch: ${employee.id}`);
      }
      if (internalIds.has(session.handle.internalSessionId)) {
        throw new Error("checkpoint internal session IDs must be unique");
      }
      internalIds.add(session.handle.internalSessionId);
      if (session.handle.nativeSessionId !== null) {
        if (nativeIds.has(session.handle.nativeSessionId)) {
          throw new Error("checkpoint native session IDs must be unique");
        }
        nativeIds.add(session.handle.nativeSessionId);
      }
      if (
        session.activeTaskId !== null
        && !this.#store.listTasks(this.#companyId).some((task) =>
          task.id === session.activeTaskId && task.ownerEmployeeId === employee.id
        )
      ) {
        throw new Error(`checkpoint active task is not owned by employee: ${employee.id}`);
      }
    }
  }

  #checkpointFromStored(stored: StoredCheckpoint): CompanyCheckpoint {
    if (stored.companyId !== this.#companyId) {
      throw new Error(`checkpoint company mismatch: ${stored.companyId}`);
    }
    return parseCompanyCheckpoint(stored.payload);
  }

  #runOperation<T>(kind: ActiveOperation["kind"], run: () => Promise<T>): Promise<T> {
    const promise = run().finally(() => {
      if (this.#operation?.promise === promise) this.#operation = null;
    });
    this.#operation = { kind, promise };
    return promise;
  }

  #deadline(timeoutMs: number): Deadline {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return { at: Date.now() + timeoutMs, controller, timer };
  }

  #phaseSignal(deadline: Deadline, maxMs: number): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    return this.#signalUntil(Math.min(deadline.at, Date.now() + maxMs));
  }

  #signalUntil(at: number): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const remaining = at - Date.now();
    if (remaining <= 0) {
      controller.abort();
      return {
        signal: controller.signal,
        dispose: () => undefined
      };
    }
    const timer = setTimeout(() => controller.abort(), remaining);
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        controller.abort();
      }
    };
  }

  #pauseApprovalEvent(
    reason: "pause_failed" | "cleanup_failed",
    payload: Record<string, unknown>
  ): NewEvent {
    return this.#event("user.approval.requested", "core", null, {
      ...payload,
      reason,
      operation: reason === "pause_failed" ? "complete company pause" : "clean up sessions",
      impact: reason === "pause_failed"
        ? "AgentTown could not complete the pause safely."
        : "AgentTown cannot prove all processes stopped.",
      alternatives: ["retry_cleanup", "inspect_processes", "keep_blocked"],
      consequenceOfNonApproval: "The company remains blocked.",
      question: "How should AgentTown resolve the lifecycle cleanup failure?",
      options: ["retry_cleanup", "inspect_processes", "keep_blocked"]
    });
  }

  #stopApprovalEvent(
    reason: "stop_failed" | "stop_cleanup_failed",
    payload: Record<string, unknown>
  ): NewEvent {
    return this.#event("user.approval.requested", "core", null, {
      ...payload,
      reason,
      operation: "complete company stop",
      impact: reason === "stop_failed"
        ? "AgentTown could not complete the stop safely."
        : "AgentTown cannot prove all processes stopped after the stop request.",
      alternatives: ["retry_stop", "inspect_processes", "keep_blocked"],
      consequenceOfNonApproval: "The company remains blocked.",
      question: "How should AgentTown resolve the company stop failure?",
      options: ["retry_stop", "inspect_processes", "keep_blocked"]
    });
  }

  #invalidCheckpointApproval(error: unknown): NewEvent {
    return this.#event("user.approval.requested", "core", null, {
      reason: "invalid_checkpoint",
      error: errorMessage(error),
      operation: "select a valid recovery checkpoint",
      impact: "Recovery did not start any Agent process.",
      alternatives: ["repair_checkpoint", "select_checkpoint", "keep_blocked"],
      consequenceOfNonApproval: "The company remains blocked without starting processes.",
      question: "Should AgentTown repair this checkpoint or use another checkpoint?",
      options: ["repair_checkpoint", "select_checkpoint", "keep_blocked"]
    });
  }

  #recoveryApproval(
    reason: "recovery_failed" | "cleanup_failed",
    employeeId: string,
    error: unknown
  ): NewEvent {
    const cleanup = reason === "cleanup_failed";
    return this.#event("user.approval.requested", "core", null, {
      reason,
      employeeId,
      error: errorMessage(error),
      operation: cleanup ? "clean up recovery processes" : "retry company recovery",
      impact: cleanup
        ? "AgentTown cannot prove all recovery processes stopped."
        : "Recovery stopped before all employees were restored.",
      alternatives: cleanup
        ? ["retry_cleanup", "inspect_processes", "keep_blocked"]
        : ["retry_recovery", "inspect_agent_config", "keep_blocked"],
      consequenceOfNonApproval: "The company remains blocked.",
      question: cleanup
        ? "How should AgentTown clean up the recovery processes?"
        : "Should AgentTown retry recovery or inspect Agent configuration?",
      options: cleanup
        ? ["retry_cleanup", "inspect_processes", "keep_blocked"]
        : ["retry_recovery", "inspect_agent_config", "keep_blocked"]
    });
  }

  async #cleanupWithinDeadline(deadline: Deadline): Promise<StopOutcome[]> {
    this.#sessions.cancelPendingReplacements();
    const forceTailMs = Math.max(
      1,
      Math.min(1_000, Math.floor(this.#pauseTimeoutMs * 0.15))
    );
    while (true) {
      const initialOwnership = this.#sessions.cleanupOwnershipSnapshot();
      if (this.#remaining(deadline) === 0) {
        if (initialOwnership.owners.length > 0) {
          return this.#abortedOwnershipOutcomes(initialOwnership.owners);
        }
        if (await this.#ownershipIsStablyEmpty()) return [];
        const racedOwnership = this.#sessions.cleanupOwnershipSnapshot();
        return racedOwnership.owners.length > 0
          ? this.#abortedOwnershipOutcomes(racedOwnership.owners)
          : [{
              employeeId: "unknown",
              status: "aborted",
              error: "session ownership changed during cleanup enumeration"
            }];
      }
      if (initialOwnership.owners.length === 0 && await this.#ownershipIsStablyEmpty()) {
        return [];
      }
      if (this.#remaining(deadline) === 0) {
        return this.#abortedOwnershipOutcomes(
          this.#sessions.cleanupOwnershipSnapshot().owners
        );
      }
      const gracefulSignal = this.#signalUntil(
        Math.max(Date.now(), deadline.at - forceTailMs)
      );
      const graceful = await this.#sessions.stopAllBounded(
        gracefulSignal.signal,
        false,
        deadline.at
      );
      gracefulSignal.dispose();
      if (this.#remaining(deadline) === 0) {
        return this.#lateCleanupOutcomes(graceful);
      }
      if (graceful.length === 0) {
        if (await this.#ownershipIsStablyEmpty()) return [];
        if (this.#remaining(deadline) === 0) {
          return this.#abortedOwnershipOutcomes(
            this.#sessions.cleanupOwnershipSnapshot().owners
          );
        }
        continue;
      }
      if (graceful.every(({ status }) => status === "stopped")) {
        if (await this.#ownershipIsStablyEmpty()) return [];
        if (this.#remaining(deadline) === 0) {
          return this.#abortedOwnershipOutcomes(
            this.#sessions.cleanupOwnershipSnapshot().owners
          );
        }
        continue;
      }
      if (this.#remaining(deadline) === 0) {
        return graceful.filter(({ status }) => status !== "stopped");
      }
      const forceSignal = this.#signalUntil(deadline.at);
      const forced = await this.#sessions.stopAllBounded(
        forceSignal.signal,
        true,
        deadline.at
      );
      forceSignal.dispose();
      if (this.#remaining(deadline) === 0) {
        return this.#lateCleanupOutcomes(forced);
      }
      if (forced.length === 0) {
        if (await this.#ownershipIsStablyEmpty()) return [];
        if (this.#remaining(deadline) === 0) {
          return this.#abortedOwnershipOutcomes(
            this.#sessions.cleanupOwnershipSnapshot().owners
          );
        }
        continue;
      }
      if (forced.every(({ status }) => status === "stopped")) continue;
      return forced.filter(({ status }) => status !== "stopped");
    }
  }

  async #ownershipIsStablyEmpty(): Promise<boolean> {
    const first = this.#sessions.cleanupOwnershipSnapshot();
    if (first.owners.length > 0) return false;
    await Promise.resolve();
    const second = this.#sessions.cleanupOwnershipSnapshot();
    return second.owners.length === 0 && second.version === first.version;
  }

  #abortedOwnershipOutcomes(
    owners: ReturnType<SessionManager["cleanupOwnershipSnapshot"]>["owners"]
  ): StopOutcome[] {
    return owners.map((owner) => ({
      employeeId: owner.employeeId,
      status: "aborted",
      error: owner.kind === "pending_replacement"
        ? "replacement creation still pending"
        : "stop aborted"
    }));
  }

  #lateCleanupOutcomes(outcomes: readonly StopOutcome[]): StopOutcome[] {
    if (outcomes.length === 0) {
      return [{
        employeeId: "unknown",
        status: "aborted",
        error: "cleanup attempt crossed the company pause deadline"
      }];
    }
    return outcomes.map((outcome) => ({
      employeeId: outcome.employeeId,
      status: "aborted",
      error: outcome.status === "stopped"
        ? "stop completed after the company pause deadline"
        : outcome.error ?? "stop exceeded the company pause deadline"
    }));
  }

  #remaining(deadline: Deadline): number {
    return Math.max(0, deadline.at - Date.now());
  }

  #event(
    type: string,
    actorId: string,
    taskId: string | null,
    payload: Record<string, unknown>
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
}
