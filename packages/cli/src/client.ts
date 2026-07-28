import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  IPC_PROTOCOL_VERSION,
  parseIpcMessage,
  type IpcEvent,
  type IpcRequest
} from "@agenttown/runtime-contract";

interface QueueWaiter {
  resolve: (result: IteratorResult<IpcEvent>) => void;
  reject: (error: Error) => void;
}

class EventQueue implements AsyncIterable<IpcEvent> {
  readonly #events: IpcEvent[] = [];
  readonly #waiters: QueueWaiter[] = [];
  #closed = false;
  #error: Error | null = null;

  push(event: IpcEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<IpcEvent> {
    return {
      next: () => {
        const event = this.#events.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<IpcEvent>>((resolvePromise, reject) => {
          this.#waiters.push({ resolve: resolvePromise, reject });
        });
      }
    };
  }
}

function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Core returned a non-object handshake");
  }
  return value as Record<string, unknown>;
}

export class AgentTownClient {
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  readonly #events = new EventQueue();
  #buffer = "";
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #closed = false;

  private constructor(
    private readonly socket: Socket,
    private readonly clientId: string
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.#consume(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#finish());
  }

  static async connect(
    pipeName: string,
    clientId: string,
    afterSequence: number
  ): Promise<AgentTownClient> {
    if (!/^agenttown-[A-Za-z0-9-]+$/u.test(pipeName)) {
      throw new Error("invalid AgentTown pipe name");
    }
    if (clientId.length === 0) throw new Error("clientId must not be empty");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a nonnegative integer");
    }
    const socket = connect(pipePath(pipeName));
    await new Promise<void>((resolvePromise, reject) => {
      const onConnect = () => {
        socket.off("error", onError);
        resolvePromise();
      };
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
    const client = new AgentTownClient(socket, clientId);
    try {
      const handshake = record(await client.request("handshake", {
        protocolVersion: IPC_PROTOCOL_VERSION,
        clientId,
        afterSequence
      }));
      const ttlMs = handshake.leaseTtlMs;
      if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) <= 0) {
        throw new Error("Core handshake omitted a valid leaseTtlMs");
      }
      client.#startHeartbeat(ttlMs as number);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("AgentTown client is closed"));
    const requestId = randomUUID();
    const request: IpcRequest = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      method,
      params
    };
    return new Promise<unknown>((resolvePromise, reject) => {
      this.#pending.set(requestId, { resolve: resolvePromise, reject });
      this.socket.write(`${JSON.stringify(request)}\n`, (error) => {
        if (error === null || error === undefined) return;
        this.#pending.delete(requestId);
        reject(error);
      });
    });
  }

  events(): AsyncIterable<IpcEvent> {
    return this.#events;
  }

  async close(): Promise<void> {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolvePromise) => {
      if (this.socket.destroyed) {
        resolvePromise();
        return;
      }
      this.socket.once("close", () => resolvePromise());
      this.socket.end();
    });
  }

  #startHeartbeat(ttlMs: number): void {
    this.#heartbeat = setInterval(() => {
      void this.request("client.heartbeat", { clientId: this.clientId })
        .catch(() => undefined);
    }, Math.max(1, Math.floor(ttlMs / 3)));
    this.#heartbeat.unref();
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message = parseIpcMessage(JSON.parse(line) as unknown);
        if (message.kind === "event") {
          this.#events.push(message);
          continue;
        }
        if (message.kind !== "response") continue;
        const pending = this.#pending.get(message.requestId);
        if (pending === undefined) continue;
        this.#pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.result);
        else {
          pending.reject(new Error(
            `${message.error?.code ?? "request_failed"}: `
              + `${message.error?.message ?? "Core request failed"}`
          ));
        }
      } catch (error) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  #fail(error: Error): void {
    if (!this.socket.destroyed) this.socket.destroy(error);
    this.#events.close(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #finish(): void {
    this.#closed = true;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#events.close();
    const error = new Error("Core connection closed");
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
