import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  CompanyCheckpoint,
  CompanyDefinition,
  EmployeeDefinition,
  RecoveryDecision,
  SessionCheckpoint,
  SessionHandle,
  TaskRecord
} from "@agenttown/runtime-contract";
import { SessionManager } from "../agents/session-manager.js";
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
  orchestrator: Pick<CompanyOrchestrator, "stopDispatching" | "resumeDispatching">;
  sessions: Pick<SessionManager, "interruptAll" | "stopAll" | "resumeOne" | "rebuildOne">;
  adapterFor: (agentName: string) => AgentAdapter;
  pauseTimeoutMs?: number;
}

export class RecoveryBlockedError extends Error {
  constructor(readonly employeeId: string, cause: unknown) {
    super(`company recovery blocked at employee ${employeeId}`, { cause });
    this.name = "RecoveryBlockedError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function readNullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readString(value, label);
}

function parseHandle(value: unknown): SessionHandle {
  if (!isRecord(value)) throw new TypeError("checkpoint handle must be an object");
  return {
    employeeId: readString(value.employeeId, "checkpoint handle employeeId"),
    adapter: readString(value.adapter, "checkpoint handle adapter"),
    internalSessionId: readString(value.internalSessionId, "checkpoint handle internalSessionId"),
    nativeSessionId: readNullableString(
      value.nativeSessionId,
      "checkpoint handle nativeSessionId"
    )
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
  if (!Array.isArray(value.sessions)) {
    throw new TypeError("checkpoint sessions must be an array");
  }
  return {
    companyId: readString(value.companyId, "checkpoint companyId"),
    reason,
    lastEventSequence: Number(value.lastEventSequence),
    sessions: value.sessions.map((sessionValue): SessionCheckpoint => {
      if (!isRecord(sessionValue)) throw new TypeError("checkpoint session must be an object");
      const employeeId = readString(
        sessionValue.employeeId,
        "checkpoint session employeeId"
      );
      const handle = parseHandle(sessionValue.handle);
      if (handle.employeeId !== employeeId) {
        throw new TypeError(`checkpoint handle employee mismatch: ${employeeId}`);
      }
      return {
        employeeId,
        handle,
        activeTaskId: readNullableString(
          sessionValue.activeTaskId,
          "checkpoint session activeTaskId"
        ),
        handoff: readString(sessionValue.handoff, "checkpoint session handoff")
      };
    })
  };
}

export class CheckpointService {
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #store: CoreStore;
  readonly #orchestrator: CheckpointServiceOptions["orchestrator"];
  readonly #sessions: CheckpointServiceOptions["sessions"];
  readonly #adapterFor: CheckpointServiceOptions["adapterFor"];
  readonly #pauseTimeoutMs: number;
  #pauseInFlight: Promise<CompanyCheckpoint> | null = null;

  constructor(options: CheckpointServiceOptions) {
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#store = options.store;
    this.#orchestrator = options.orchestrator;
    this.#sessions = options.sessions;
    this.#adapterFor = options.adapterFor;
    this.#pauseTimeoutMs = options.pauseTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.#pauseTimeoutMs) || this.#pauseTimeoutMs <= 0) {
      throw new RangeError("pauseTimeoutMs must be a positive integer");
    }
  }

  pause(reason: PauseReason): Promise<CompanyCheckpoint> {
    if (this.#pauseInFlight !== null) return this.#pauseInFlight;
    const operation = this.#pause(reason).finally(() => {
      if (this.#pauseInFlight === operation) this.#pauseInFlight = null;
    });
    this.#pauseInFlight = operation;
    return operation;
  }

  async recoverLatest(): Promise<RecoveryResult> {
    const stored = this.#store.latestCheckpoint(this.#companyId);
    if (stored === null) throw new Error(`checkpoint not found: ${this.#companyId}`);
    return this.recover(this.#checkpointFromStored(stored));
  }

  async recover(
    checkpoint: CompanyCheckpoint,
    company: CompanyDefinition = this.#company
  ): Promise<RecoveryResult> {
    this.#validateCheckpointRoster(checkpoint, company);
    await this.#orchestrator.stopDispatching();
    const decisions: RecoveryDecision[] = [];
    let currentEmployeeId = "unknown";
    try {
      for (const employee of company.employees) {
        currentEmployeeId = employee.id;
        const session = checkpoint.sessions.find(
          ({ employeeId }) => employeeId === employee.id
        );
        if (session === undefined) throw new Error(`checkpoint session missing: ${employee.id}`);
        const capabilities = await this.#adapterFor(employee.agent).capabilities();
        const native = capabilities.nativeResume === "supported"
          && session.handle.nativeSessionId !== null;
        const handle = native
          ? await this.#sessions.resumeOne(employee, session)
          : await this.#sessions.rebuildOne(employee, session.handoff);
        const decision: RecoveryDecision = {
          employeeId: employee.id,
          mode: native ? "native" : "rebuilt"
        };
        decisions.push(decision);
        this.#store.insertEvent(this.#event(
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
      this.#store.setCompanyStatus(
        this.#companyId,
        "running",
        this.#event("company.recovered", "core", null, { decisions })
      );
      this.#orchestrator.resumeDispatching();
      return { decisions };
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.#sessions.stopAll();
      } catch (stopError) {
        cleanupError = stopError;
      }
      this.#store.setCompanyStatus(
        this.#companyId,
        "blocked",
        this.#event("company.recovery_blocked", "core", null, {
          employeeId: currentEmployeeId,
          error: errorMessage(error),
          cleanupError: cleanupError === undefined ? null : errorMessage(cleanupError)
        })
      );
      throw new RecoveryBlockedError(currentEmployeeId, error);
    }
  }

  async #pause(reason: PauseReason): Promise<CompanyCheckpoint> {
    await this.#orchestrator.stopDispatching();
    await this.#interruptWithinDeadline();
    const checkpoint = this.#buildCheckpoint(reason);
    this.#store.putCheckpoint(
      {
        id: randomUUID(),
        companyId: this.#companyId,
        createdAt: new Date().toISOString(),
        payload: checkpoint as unknown as Record<string, unknown>
      },
      this.#event("company.checkpointed", "core", null, {
        reason,
        lastEventSequence: checkpoint.lastEventSequence,
        sessionCount: checkpoint.sessions.length
      })
    );
    this.#store.setCompanyStatus(
      this.#companyId,
      "paused",
      this.#event("company.paused", "core", null, { reason })
    );
    await this.#sessions.stopAll();
    return checkpoint;
  }

  async #interruptWithinDeadline(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = this.#sessions.interruptAll().then(
      () => "interrupted" as const,
      (error) => ({ error })
    );
    const timed = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), this.#pauseTimeoutMs);
    });
    const result = await Promise.race([outcome, timed]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (result === "timeout") {
      this.#store.insertEvent(this.#event("company.pause_timeout", "core", null, {
        timeoutMs: this.#pauseTimeoutMs
      }));
    } else if (result !== "interrupted") {
      this.#store.insertEvent(this.#event("session.interrupt_failed", "core", null, {
        error: errorMessage(result.error)
      }));
    }
  }

  #buildCheckpoint(reason: PauseReason): CompanyCheckpoint {
    const events = this.#store.listEvents(0);
    const tasks = this.#store.listTasks(this.#companyId);
    const sessionsByEmployee = new Map(
      this.#store.listSessions(this.#companyId)
        .map((session) => [session.employeeId, session] as const)
    );
    return {
      companyId: this.#companyId,
      reason,
      lastEventSequence: events.at(-1)?.sequence ?? 0,
      sessions: this.#company.employees.map((employee) => {
        const session = sessionsByEmployee.get(employee.id);
        if (session === undefined) throw new Error(`active session fact missing: ${employee.id}`);
        const activeTask = this.#activeTask(tasks, employee.id);
        return {
          employeeId: employee.id,
          handle: session.handle,
          activeTaskId: activeTask?.id ?? null,
          handoff: this.#handoff(employee, activeTask)
        };
      })
    };
  }

  #activeTask(tasks: readonly TaskRecord[], employeeId: string): TaskRecord | undefined {
    return tasks.find((task) =>
      task.ownerEmployeeId === employeeId
      && (task.status === "running" || task.status === "review")
    );
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

  #validateCheckpointRoster(
    checkpoint: CompanyCheckpoint,
    company: CompanyDefinition
  ): void {
    if (checkpoint.companyId !== this.#companyId) {
      throw new Error(`checkpoint company mismatch: ${checkpoint.companyId}`);
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
  }

  #checkpointFromStored(stored: StoredCheckpoint): CompanyCheckpoint {
    if (stored.companyId !== this.#companyId) {
      throw new Error(`checkpoint company mismatch: ${stored.companyId}`);
    }
    return parseCompanyCheckpoint(stored.payload);
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
