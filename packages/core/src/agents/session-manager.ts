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

export class SessionManager {
  readonly #sessions = new Map<string, SessionHandle>();
  readonly #sendTails = new Map<string, Promise<void>>();

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
      }
    } catch (error) {
      await this.#stopStartedHandles(company, results);
      for (const employee of company.employees) {
        this.#sessions.delete(employee.id);
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
    message: AgentMessage
  ): AsyncIterable<AgentEvent> {
    if (message.employeeId !== employee.id) {
      throw new Error(`message employee mismatch: ${message.employeeId}`);
    }
    const release = await this.#acquire(employee.id);
    try {
      const session = this.get(employee.id);
      for await (const event of this.adapterFor(employee.agent).send(session, message)) {
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
          this.store.putSession(
            this.companyId,
            employee.id,
            session,
            "exited",
            this.#agentEvent(employee.id, message, event)
          );
        } else if (event.type === "adapter.error") {
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

  async interruptAll(): Promise<void> {
    const entries = [...this.#sessions.entries()];
    await Promise.all(entries.map(async ([employeeId, session]) => {
      const employee = this.#employeeAdapterName(session);
      const result = await this.adapterFor(employee).interrupt(session);
      if (result.interrupted) {
        this.store.putSession(
          this.companyId,
          employeeId,
          session,
          "interrupted",
          this.#newEvent("session.interrupted", employeeId, null, {
            reason: "requested"
          })
        );
      }
    }));
  }

  async stopAll(): Promise<void> {
    const entries = [...this.#sessions.entries()].reverse();
    const errors: Error[] = [];
    for (const [employeeId, session] of entries) {
      try {
        await this.adapterFor(this.#employeeAdapterName(session)).stop(session);
      } catch (error) {
        errors.push(new Error(`${employeeId}: ${this.#errorMessage(error)}`));
      }
      try {
        this.store.putSession(
          this.companyId,
          employeeId,
          session,
          "stopped",
          this.#newEvent("session.stopped", employeeId, null, {})
        );
      } catch (error) {
        errors.push(new Error(`${employeeId} persistence: ${this.#errorMessage(error)}`));
      } finally {
        this.#sessions.delete(employeeId);
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
    checkpoint: SessionCheckpoint
  ): Promise<SessionHandle> {
    if (checkpoint.employeeId !== employee.id) {
      throw new Error(`checkpoint employee mismatch: ${checkpoint.employeeId}`);
    }
    const release = await this.#acquire(employee.id);
    try {
      const handle = await this.adapterFor(employee.agent).resume({
        employeeId: employee.id,
        role: employee.role,
        projectRoot: this.projectRoot,
        scenario: "idle",
        previous: checkpoint.handle,
        handoff: checkpoint.handoff
      });
      this.store.putSession(
        this.companyId,
        employee.id,
        handle,
        "running",
        this.#newEvent("session.started", employee.id, checkpoint.activeTaskId, {
          handle,
          resumed: true
        })
      );
      this.#sessions.set(employee.id, handle);
      return handle;
    } finally {
      release();
    }
  }

  async rebuildOne(
    employee: EmployeeDefinition,
    handoff: string
  ): Promise<SessionHandle> {
    const release = await this.#acquire(employee.id);
    try {
      const handle = await this.adapterFor(employee.agent).start({
        employeeId: employee.id,
        role: employee.role,
        projectRoot: this.projectRoot,
        scenario: "idle"
      });
      this.store.putSession(
        this.companyId,
        employee.id,
        handle,
        "running",
        this.#newEvent("session.started", employee.id, null, {
          handle,
          rebuilt: true,
          handoff
        })
      );
      this.#sessions.set(employee.id, handle);
      return handle;
    } finally {
      release();
    }
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
      } catch {
        // Rollback is best effort, but every successfully started handle is attempted.
      }
    }
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  #employeeAdapterName(session: SessionHandle): string {
    return session.adapter;
  }
}
