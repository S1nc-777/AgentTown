import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentEvent,
  AgentMessage,
  CompanyDefinition,
  EmployeeDefinition,
  SessionCheckpoint,
  SessionHandle
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../storage/core-store.js";

export class SessionReplacementCleanupError extends AggregateError {
  constructor(persistenceError: unknown, stopError: unknown) {
    super(
      [persistenceError, stopError],
      "replacement session persistence failed and cleanup stop also failed"
    );
    this.name = "SessionReplacementCleanupError";
  }
}

export interface InterruptOutcome {
  employeeId: string;
  status: "interrupted" | "not_interrupted" | "failed" | "aborted";
  error: string | null;
}

export interface StopOutcome {
  employeeId: string;
  status: "stopped" | "failed" | "aborted";
  error: string | null;
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #unavailableEmployees = new Set<string>();
  readonly #sendTails = new Map<string, Promise<void>>();
  readonly #cleanupHandles = new Map<string, {
    handle: SessionHandle;
    order: number;
  }>();
  readonly #handleOrders = new Map<string, number>();
  #nextHandleOrder = 0;

  constructor(
    private readonly adapterFor: (agentName: string) => AgentAdapter,
    private readonly store: CoreStore,
    private readonly companyId: string,
    private readonly projectRoot: string
  ) {}

  async startAll(
    company: CompanyDefinition,
    scenarios: Readonly<Record<string, string>>
  ): Promise<void> {
    if (this.#sessions.size > 0) throw new Error("sessions already started");
    const starts = company.employees.map(async (employee) =>
      this.adapterFor(employee.agent).start({
        employeeId: employee.id,
        role: employee.role,
        projectRoot: this.projectRoot,
        scenario: scenarios[employee.id] ?? "idle"
      })
    );
    const results = await Promise.allSettled(starts);
    for (const result of results) {
      if (result.status === "fulfilled") this.#registerHandle(result.value);
    }
    const failedEmployeeIds = results.flatMap((result, index) =>
      result.status === "rejected" ? [company.employees[index]?.id ?? `index-${index}`] : []
    );

    if (failedEmployeeIds.length > 0) {
      await this.#stopStartedHandles(company, results);
      throw new Error(`failed to start employees: ${failedEmployeeIds.join(", ")}`);
    }

    try {
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        const employee = company.employees[index];
        if (result?.status !== "fulfilled" || employee === undefined) {
          throw new Error("session start result mismatch");
        }
        this.store.putSession(
          this.companyId,
          employee.id,
          result.value,
          "running",
          this.#newEvent("session.started", employee.id, null, {
            handle: result.value
          })
        );
        this.#sessions.set(employee.id, result.value);
        this.#unavailableEmployees.delete(employee.id);
      }
    } catch (error) {
      await this.#stopStartedHandles(company, results);
      for (const employee of company.employees) {
        this.#sessions.delete(employee.id);
        this.#unavailableEmployees.delete(employee.id);
        try {
          this.store.deleteSession(
            this.companyId,
            employee.id,
            this.#newEvent("session.start_rolled_back", employee.id, null, {})
          );
        } catch {
          // Continue clearing the remaining session facts before surfacing the start error.
        }
      }
      throw error;
    }
  }

  get(employeeId: string): SessionHandle {
    const session = this.#sessions.get(employeeId);
    if (session === undefined) throw new Error(`session not started: ${employeeId}`);
    return session;
  }

  async *send(
    employee: EmployeeDefinition,
    message: AgentMessage,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent> {
    if (message.employeeId !== employee.id) {
      throw new Error(`message employee mismatch: ${message.employeeId}`);
    }
    const release = await this.#acquire(employee.id);
    try {
      const session = this.get(employee.id);
      if (this.#unavailableEmployees.has(employee.id)) {
        throw new Error(`session unavailable: ${employee.id}`);
      }
      for await (const event of this.adapterFor(employee.agent).send(session, message)) {
        if (signal?.aborted === true) return;
        if (event.type === "usage.updated") {
          const usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            contextTokens: event.contextTokens,
            capturedAt: new Date().toISOString()
          };
          this.store.putUsageSnapshot(this.companyId, employee.id, usage, {
            id: randomUUID(),
            type: "usage.updated",
            actorId: employee.id,
            taskId: message.taskId,
            causationEventId: message.actionRequest?.causationEventId ?? null,
            payload: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              contextTokens: event.contextTokens
            }
          });
        } else if (event.type === "session.exited") {
          this.#unavailableEmployees.add(employee.id);
          this.store.putSession(
            this.companyId,
            employee.id,
            session,
            "exited",
            this.#agentEvent(employee.id, message, event)
          );
        } else if (event.type === "adapter.error") {
          this.#unavailableEmployees.add(employee.id);
          this.store.putSession(
            this.companyId,
            employee.id,
            session,
            "error",
            this.#agentEvent(employee.id, message, event)
          );
        } else {
          this.#persistAgentEvent(employee.id, message, event);
        }
        yield event;
      }
    } finally {
      release();
    }
  }

  async interruptAll(signal?: AbortSignal): Promise<InterruptOutcome[]> {
    const entries = [...this.#sessions.entries()];
    return Promise.all(entries.map(async ([employeeId, session]) => {
      if (this.#isAborted(signal)) {
        return { employeeId, status: "aborted", error: "interruption aborted" };
      }
      const employee = this.#employeeAdapterName(session);
      try {
        const operation = this.adapterFor(employee).interrupt(session);
        const result = await this.#raceAbort(operation, signal);
        if (result === null) {
          return { employeeId, status: "aborted", error: "interruption aborted" };
        }
        if (!result.interrupted) {
          return { employeeId, status: "not_interrupted", error: "adapter declined interrupt" };
        }
        if (this.#isAborted(signal)) {
          return { employeeId, status: "aborted", error: "interruption aborted" };
        }
        this.store.putSession(
          this.companyId,
          employeeId,
          session,
          "interrupted",
          this.#newEvent("session.interrupted", employeeId, null, {
            reason: "requested"
          })
        );
        return { employeeId, status: "interrupted", error: null };
      } catch (error) {
        return {
          employeeId,
          status: this.#isAborted(signal) ? "aborted" : "failed",
          error: this.#errorMessage(error)
        };
      }
    }));
  }

  async stopAllBounded(
    signal: AbortSignal,
    force = false
  ): Promise<StopOutcome[]> {
    const entries = this.#collectStopCandidates();
    return Promise.all(entries.map(async ([key, candidate]) => {
      const { employeeId, handle, active } = candidate;
      if (signal.aborted) {
        return { employeeId, status: "aborted", error: "stop aborted" };
      }
      const adapter = this.adapterFor(this.#employeeAdapterName(handle));
      const stop = force && adapter.forceStop !== undefined
        ? adapter.forceStop.bind(adapter)
        : adapter.stop.bind(adapter);
      try {
        const result = await this.#raceAbort(stop(handle), signal);
        if (result === null || signal.aborted) {
          return { employeeId, status: "aborted", error: "stop aborted" };
        }
        if (active) {
          this.store.putSession(
            this.companyId,
            employeeId,
            handle,
            "stopped",
            this.#newEvent("session.stopped", employeeId, null, { forced: force })
          );
          const current = this.#sessions.get(employeeId);
          if (current !== undefined && this.#handleKey(current) === key) {
            this.#sessions.delete(employeeId);
          }
        }
        this.#unavailableEmployees.delete(employeeId);
        this.#cleanupHandles.delete(key);
        this.#handleOrders.delete(key);
        return { employeeId, status: "stopped", error: null };
      } catch (error) {
        return { employeeId, status: "failed", error: this.#errorMessage(error) };
      }
    }));
  }

  async stopAll(): Promise<void> {
    const entries = this.#collectStopCandidates();
    const errors: Error[] = [];
    for (const [key, candidate] of entries) {
      const { employeeId, handle, active } = candidate;
      let adapterStopped = false;
      try {
        await this.adapterFor(this.#employeeAdapterName(handle)).stop(handle);
        adapterStopped = true;
      } catch (error) {
        errors.push(new Error(`${employeeId}: ${this.#errorMessage(error)}`));
      }
      if (!adapterStopped) continue;
      if (!active) {
        this.#cleanupHandles.delete(key);
        this.#handleOrders.delete(key);
        continue;
      }
      try {
        this.store.putSession(
          this.companyId,
          employeeId,
          handle,
          "stopped",
          this.#newEvent("session.stopped", employeeId, null, {})
        );
        const activeHandle = this.#sessions.get(employeeId);
        if (
          activeHandle !== undefined
          && this.#handleKey(activeHandle) === key
        ) {
          this.#sessions.delete(employeeId);
        }
        this.#unavailableEmployees.delete(employeeId);
        this.#cleanupHandles.delete(key);
        this.#handleOrders.delete(key);
      } catch (error) {
        errors.push(new Error(`${employeeId} persistence: ${this.#errorMessage(error)}`));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `failed to stop sessions: ${errors.map((error) => error.message).join("; ")}`
      );
    }
  }

  async resumeOne(
    employee: EmployeeDefinition,
    checkpoint: SessionCheckpoint,
    signal?: AbortSignal
  ): Promise<SessionHandle> {
    if (checkpoint.employeeId !== employee.id) {
      throw new Error(`checkpoint employee mismatch: ${checkpoint.employeeId}`);
    }
    const release = await this.#acquire(employee.id);
    try {
      if (signal?.aborted === true) throw new Error("session replacement aborted");
      const handle = await this.adapterFor(employee.agent).resume({
        employeeId: employee.id,
        role: employee.role,
        projectRoot: this.projectRoot,
        scenario: "idle",
        previous: checkpoint.handle,
        handoff: checkpoint.handoff
      });
      this.#registerHandle(handle);
      await this.#rejectAbortedReplacement(employee, handle, signal);
      await this.#persistReplacement(
        employee,
        handle,
        this.#newEvent("session.started", employee.id, checkpoint.activeTaskId, {
          handle,
          resumed: true
        })
      );
      return handle;
    } finally {
      release();
    }
  }

  async rebuildOne(
    employee: EmployeeDefinition,
    handoff: string,
    signal?: AbortSignal
  ): Promise<SessionHandle> {
    const release = await this.#acquire(employee.id);
    try {
      if (signal?.aborted === true) throw new Error("session replacement aborted");
      const handle = await this.adapterFor(employee.agent).start({
        employeeId: employee.id,
        role: employee.role,
        projectRoot: this.projectRoot,
        scenario: "idle"
      });
      this.#registerHandle(handle);
      await this.#rejectAbortedReplacement(employee, handle, signal);
      await this.#persistReplacement(
        employee,
        handle,
        this.#newEvent("session.started", employee.id, null, {
          handle,
          rebuilt: true,
          handoff
        })
      );
      return handle;
    } finally {
      release();
    }
  }

  async #raceAbort<T>(
    operation: Promise<T>,
    signal: AbortSignal | undefined
  ): Promise<T | null> {
    if (signal === undefined) return operation;
    if (signal.aborted) return null;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolvePromise) => {
          onAbort = () => resolvePromise(null);
          signal.addEventListener("abort", onAbort, { once: true });
        })
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      void operation.catch(() => undefined);
    }
  }

  #isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted ?? false;
  }

  async #rejectAbortedReplacement(
    employee: EmployeeDefinition,
    handle: SessionHandle,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (signal?.aborted !== true) return;
    try {
      await this.adapterFor(employee.agent).stop(handle);
      this.#forgetHandle(handle);
    } catch (stopError) {
      this.#retainForCleanup(handle);
      throw new AggregateError(
        [stopError],
        `session replacement aborted and cleanup stop failed: ${employee.id}`
      );
    }
    throw new Error(`session replacement aborted: ${employee.id}`);
  }

  #collectStopCandidates(): Array<[string, {
    employeeId: string;
    handle: SessionHandle;
    active: boolean;
    order: number;
  }]> {
    const candidates = new Map<string, {
      employeeId: string;
      handle: SessionHandle;
      active: boolean;
      order: number;
    }>();
    for (const [employeeId, handle] of this.#sessions) {
      const key = this.#handleKey(handle);
      candidates.set(key, {
        employeeId,
        handle,
        active: true,
        order: this.#registerHandle(handle)
      });
    }
    for (const [key, cleanup] of this.#cleanupHandles) {
      if (candidates.has(key)) continue;
      candidates.set(key, {
        employeeId: cleanup.handle.employeeId,
        handle: cleanup.handle,
        active: false,
        order: cleanup.order
      });
    }
    return [...candidates.entries()].sort(
      ([, left], [, right]) => right.order - left.order
    );
  }

  #persistAgentEvent(
    employeeId: string,
    message: AgentMessage,
    event: Exclude<AgentEvent, { type: "usage.updated" }>
  ): void {
    let payload: Record<string, unknown>;
    switch (event.type) {
      case "session.started":
        payload = { handle: event.handle };
        break;
      case "output.delta":
      case "output.completed":
        payload = { text: event.text };
        break;
      case "action.proposed":
        payload = { action: event.action };
        break;
      case "session.interrupted":
        payload = { reason: event.reason };
        break;
      case "session.exited":
        payload = { exitCode: event.exitCode };
        break;
      case "adapter.error":
        payload = { code: event.code, message: event.message };
        break;
    }
    this.store.insertEvent(this.#newEvent(
      event.type,
      employeeId,
      message.taskId,
      payload
    ));
  }

  #agentEvent(
    employeeId: string,
    message: AgentMessage,
    event: Extract<AgentEvent, { type: "session.exited" | "adapter.error" }>
  ): NewEvent {
    const payload = event.type === "session.exited"
      ? { exitCode: event.exitCode }
      : { code: event.code, message: event.message };
    return this.#newEvent(event.type, employeeId, message.taskId, payload);
  }

  #newEvent(
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

  async #acquire(employeeId: string): Promise<() => void> {
    const previous = this.#sendTails.get(employeeId) ?? Promise.resolve();
    let releaseTail: () => void = () => undefined;
    const tail = new Promise<void>((resolvePromise) => {
      releaseTail = resolvePromise;
    });
    this.#sendTails.set(employeeId, tail);
    await previous;
    return () => {
      releaseTail();
      if (this.#sendTails.get(employeeId) === tail) {
        this.#sendTails.delete(employeeId);
      }
    };
  }

  async #stopStartedHandles(
    company: CompanyDefinition,
    results: readonly PromiseSettledResult<SessionHandle>[]
  ): Promise<void> {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const result = results[index];
      const employee = company.employees[index];
      if (result?.status !== "fulfilled" || employee === undefined) continue;
      try {
        await this.adapterFor(employee.agent).stop(result.value);
        this.#forgetHandle(result.value);
      } catch {
        this.#retainForCleanup(result.value);
      }
    }
  }

  async #persistReplacement(
    employee: EmployeeDefinition,
    handle: SessionHandle,
    event: NewEvent
  ): Promise<void> {
    try {
      this.store.putSession(
        this.companyId,
        employee.id,
        handle,
        "running",
        event
      );
    } catch (persistenceError) {
      try {
        await this.adapterFor(employee.agent).stop(handle);
        this.#forgetHandle(handle);
      } catch (stopError) {
        this.#retainForCleanup(handle);
        throw new SessionReplacementCleanupError(persistenceError, stopError);
      }
      throw persistenceError;
    }
    const previous = this.#sessions.get(employee.id);
    this.#sessions.set(employee.id, handle);
    this.#unavailableEmployees.delete(employee.id);
    if (previous !== undefined && this.#handleKey(previous) !== this.#handleKey(handle)) {
      this.#forgetHandle(previous);
    }
  }

  #registerHandle(handle: SessionHandle): number {
    const key = this.#handleKey(handle);
    const existing = this.#handleOrders.get(key);
    if (existing !== undefined) return existing;
    this.#nextHandleOrder += 1;
    this.#handleOrders.set(key, this.#nextHandleOrder);
    return this.#nextHandleOrder;
  }

  #retainForCleanup(handle: SessionHandle): void {
    const key = this.#handleKey(handle);
    this.#cleanupHandles.set(key, {
      handle,
      order: this.#registerHandle(handle)
    });
  }

  #forgetHandle(handle: SessionHandle): void {
    const key = this.#handleKey(handle);
    this.#cleanupHandles.delete(key);
    this.#handleOrders.delete(key);
  }

  #handleKey(handle: SessionHandle): string {
    return JSON.stringify([
      handle.adapter,
      handle.employeeId,
      handle.internalSessionId
    ]);
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  #employeeAdapterName(session: SessionHandle): string {
    return session.adapter;
  }
}
