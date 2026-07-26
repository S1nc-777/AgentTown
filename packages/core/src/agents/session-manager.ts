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
import { CoreStore } from "../storage/core-store.js";

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
      for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        const employee = company.employees[index];
        if (result?.status !== "fulfilled" || employee === undefined) continue;
        await this.adapterFor(employee.agent).stop(result.value).catch(() => undefined);
      }
      throw new Error(`failed to start employees: ${failedEmployeeIds.join(", ")}`);
    }

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const employee = company.employees[index];
      if (result?.status !== "fulfilled" || employee === undefined) {
        throw new Error("session start result mismatch");
      }
      this.#sessions.set(employee.id, result.value);
      this.store.putSession(this.companyId, employee.id, result.value, "running");
      this.#recordEvent("session.started", employee.id, null, {
        handle: result.value
      });
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
    const session = this.get(employee.id);
    const previous = this.#sendTails.get(employee.id) ?? Promise.resolve();
    let releaseTail: () => void = () => undefined;
    const tail = new Promise<void>((resolvePromise) => {
      releaseTail = resolvePromise;
    });
    this.#sendTails.set(employee.id, tail);

    await previous;
    try {
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
          this.store.putSession(this.companyId, employee.id, session, "exited");
          this.#persistAgentEvent(employee.id, message, event);
        } else if (event.type === "adapter.error") {
          this.store.putSession(this.companyId, employee.id, session, "error");
          this.#persistAgentEvent(employee.id, message, event);
        } else {
          this.#persistAgentEvent(employee.id, message, event);
        }
        yield event;
      }
    } finally {
      releaseTail();
      if (this.#sendTails.get(employee.id) === tail) {
        this.#sendTails.delete(employee.id);
      }
    }
  }

  async interruptAll(): Promise<void> {
    const entries = [...this.#sessions.entries()];
    await Promise.all(entries.map(async ([employeeId, session]) => {
      const employee = this.#employeeAdapterName(session);
      const result = await this.adapterFor(employee).interrupt(session);
      if (result.interrupted) {
        this.store.putSession(this.companyId, employeeId, session, "interrupted");
        this.#recordEvent("session.interrupted", employeeId, null, {
          reason: "requested"
        });
      }
    }));
  }

  async stopAll(): Promise<void> {
    const entries = [...this.#sessions.entries()].reverse();
    for (const [employeeId, session] of entries) {
      await this.adapterFor(this.#employeeAdapterName(session)).stop(session);
      this.store.putSession(this.companyId, employeeId, session, "stopped");
      this.#sessions.delete(employeeId);
    }
  }

  async resumeOne(
    employee: EmployeeDefinition,
    checkpoint: SessionCheckpoint
  ): Promise<SessionHandle> {
    if (checkpoint.employeeId !== employee.id) {
      throw new Error(`checkpoint employee mismatch: ${checkpoint.employeeId}`);
    }
    const handle = await this.adapterFor(employee.agent).resume({
      employeeId: employee.id,
      role: employee.role,
      projectRoot: this.projectRoot,
      scenario: "idle",
      previous: checkpoint.handle,
      handoff: checkpoint.handoff
    });
    this.#sessions.set(employee.id, handle);
    this.store.putSession(this.companyId, employee.id, handle, "running");
    this.#recordEvent("session.started", employee.id, checkpoint.activeTaskId, {
      handle,
      resumed: true
    });
    return handle;
  }

  async rebuildOne(
    employee: EmployeeDefinition,
    handoff: string
  ): Promise<SessionHandle> {
    const handle = await this.adapterFor(employee.agent).start({
      employeeId: employee.id,
      role: employee.role,
      projectRoot: this.projectRoot,
      scenario: "idle"
    });
    this.#sessions.set(employee.id, handle);
    this.store.putSession(this.companyId, employee.id, handle, "running");
    this.#recordEvent("session.started", employee.id, null, {
      handle,
      rebuilt: true,
      handoff
    });
    return handle;
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
    this.#recordEvent(event.type, employeeId, message.taskId, payload);
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

  #employeeAdapterName(session: SessionHandle): string {
    return session.adapter;
  }
}
