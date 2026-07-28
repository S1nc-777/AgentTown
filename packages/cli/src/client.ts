import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  IPC_PROTOCOL_VERSION,
  parseIpcMessage,
  type IpcEvent,
  type IpcRequest
} from "@agenttown/runtime-contract";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_QUEUE = 256;
const MAX_EVENT_QUEUE_BYTES = 4 * 1024 * 1024;
const EVENT_RESUME_WATERMARK = 128;
const MAX_PENDING_REQUESTS = 256;
const MAX_QUEUED_WRITE_BYTES = 4 * 1024 * 1024;

interface QueueWaiter {
  resolve: (result: IteratorResult<IpcEvent>) => void;
  reject: (error: Error) => void;
}

interface QueuedEvent {
  event: IpcEvent;
  bytes: number;
}

export class EventQueue implements AsyncIterable<IpcEvent> {
  readonly #events: QueuedEvent[] = [];
  readonly #waiters: QueueWaiter[] = [];
  #closed = false;
  #error: Error | null = null;
  #queuedBytes = 0;

  constructor(private readonly onSpace: () => void) {}

  get size(): number {
    return this.#events.length;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  push(event: IpcEvent, bytes: number): boolean {
    if (this.#closed) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("event byte size must be a nonnegative integer");
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value: event });
      return true;
    }
    if (
      this.#events.length >= MAX_EVENT_QUEUE
      || this.#queuedBytes + bytes > MAX_EVENT_QUEUE_BYTES
    ) {
      return false;
    }
    this.#events.push({ event, bytes });
    this.#queuedBytes += bytes;
    return true;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    this.#events.length = 0;
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ done: true, value: undefined });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<IpcEvent> {
    return {
      next: () => {
        const queued = this.#events.shift();
        if (queued !== undefined) {
          this.#queuedBytes -= queued.bytes;
          this.onSpace();
          return Promise.resolve({ done: false, value: queued.event });
        }
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
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

function timeoutError(label: string, timeoutMs: number): Error {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

export class AgentTownClient {
  readonly #pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  readonly #events: EventQueue;
  #buffer = "";
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #heartbeatInFlight = false;
  #inputPaused = false;
  #closed = false;
  #writeTail: Promise<void> = Promise.resolve();
  #queuedWriteBytes = 0;

  private constructor(
    private readonly socket: Socket,
    private readonly clientId: string
  ) {
    this.#events = new EventQueue(() => this.#resumeInputIfPossible());
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.#consume();
    });
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#finish());
  }

  static async connect(
    pipeName: string,
    clientId: string,
    afterSequence: number,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS
  ): Promise<AgentTownClient> {
    if (!/^agenttown-[A-Za-z0-9-]+$/u.test(pipeName)) {
      throw new Error("invalid AgentTown pipe name");
    }
    if (clientId.length === 0) throw new Error("clientId must not be empty");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("afterSequence must be a nonnegative integer");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("connect timeout must be a positive integer");
    }
    const deadlineAt = Date.now() + timeoutMs;
    const socket = connect(pipePath(pipeName));
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const remaining = Math.max(0, deadlineAt - Date.now());
        const timer = setTimeout(() => {
          cleanup();
          const error = timeoutError("Core connect", timeoutMs);
          socket.destroy();
          reject(error);
        }, remaining);
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("connect", onConnect);
          socket.off("error", onError);
        };
        const onConnect = () => {
          cleanup();
          resolvePromise();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
      });
      const client = new AgentTownClient(socket, clientId);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw timeoutError("Core handshake", timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const handshake = record(await Promise.race([
          client.request("handshake", {
            protocolVersion: IPC_PROTOCOL_VERSION,
            clientId,
            afterSequence
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = timeoutError("Core handshake", timeoutMs);
              client.#fail(error);
              reject(error);
            }, remaining);
          })
        ]));
        const ttlMs = handshake.leaseTtlMs;
        if (!Number.isSafeInteger(ttlMs) || (ttlMs as number) <= 0) {
          throw new Error("Core handshake omitted a valid leaseTtlMs");
        }
        client.#startHeartbeat(ttlMs as number);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      if (!socket.destroyed) socket.destroy();
      throw error;
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("AgentTown client is closed"));
    if (this.#pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error(
        `too many pending Core requests (limit ${MAX_PENDING_REQUESTS})`
      ));
    }
    const requestId = randomUUID();
    const request: IpcRequest = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "request",
      requestId,
      method,
      params
    };
    const line = `${JSON.stringify(request)}\n`;
    return new Promise<unknown>((resolvePromise, reject) => {
      this.#pending.set(requestId, { resolve: resolvePromise, reject });
      void this.#enqueueLine(line)
        .catch((error: unknown) => {
          const failure = error instanceof Error ? error : new Error(String(error));
          const pending = this.#pending.get(requestId);
          if (pending !== undefined) {
            this.#pending.delete(requestId);
            pending.reject(failure);
          }
        });
    });
  }

  events(): AsyncIterable<IpcEvent> {
    return this.#events;
  }

  async close(): Promise<void> {
    this.#stopHeartbeat();
    const closeError = new Error("AgentTown client closed");
    this.#closed = true;
    this.#events.close();
    for (const pending of this.#pending.values()) pending.reject(closeError);
    this.#pending.clear();
    if (this.socket.destroyed) return;
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.socket.off("close", finish);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        this.socket.destroy();
        finish();
      }, CLOSE_TIMEOUT_MS);
      this.socket.once("close", finish);
      this.socket.destroy();
    });
  }

  async #writeLine(line: string): Promise<void> {
    if (this.#closed || this.socket.destroyed) {
      throw new Error("AgentTown client is closed");
    }
    if (this.socket.write(line)) return;
    await new Promise<void>((resolvePromise, reject) => {
      const cleanup = () => {
        this.socket.off("drain", onDrain);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const onDrain = () => {
        cleanup();
        resolvePromise();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Core connection closed during write"));
      };
      this.socket.once("drain", onDrain);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  #enqueueLine(line: string): Promise<void> {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > MAX_LINE_BYTES) {
      return Promise.reject(new Error("Core request line exceeds maximum size"));
    }
    if (this.#queuedWriteBytes + lineBytes > MAX_QUEUED_WRITE_BYTES) {
      return Promise.reject(new Error(
        `queued Core request bytes exceed limit ${MAX_QUEUED_WRITE_BYTES}`
      ));
    }
    this.#queuedWriteBytes += lineBytes;
    const writing = this.#writeTail.then(() => this.#writeLine(line));
    const accounted = writing.finally(() => {
      this.#queuedWriteBytes -= lineBytes;
    });
    this.#writeTail = accounted.catch(() => undefined);
    return accounted;
  }

  #startHeartbeat(ttlMs: number): void {
    this.#heartbeat = setInterval(() => {
      if (this.#heartbeatInFlight || this.#closed) return;
      this.#heartbeatInFlight = true;
      const heartbeat: IpcRequest = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        kind: "request",
        requestId: randomUUID(),
        method: "client.heartbeat",
        params: { clientId: this.clientId }
      };
      void this.#enqueueLine(`${JSON.stringify(heartbeat)}\n`)
        .catch(() => undefined)
        .finally(() => {
          this.#heartbeatInFlight = false;
        });
    }, Math.max(1, Math.floor(ttlMs / 3)));
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    this.#heartbeatInFlight = false;
  }

  #consume(): void {
    if (this.#closed) return;
    while (!this.#inputPaused) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > MAX_LINE_BYTES) {
          this.#fail(new Error("Core IPC line exceeds maximum size"));
        }
        return;
      }
      if (Buffer.byteLength(this.#buffer.slice(0, newline), "utf8") > MAX_LINE_BYTES) {
        this.#fail(new Error("Core IPC line exceeds maximum size"));
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      try {
        const message = parseIpcMessage(JSON.parse(line) as unknown);
        if (message.kind === "event") {
          if (!this.#events.push(message, Buffer.byteLength(line, "utf8"))) {
            // Put the event back and stop reading until the consumer creates space.
            this.#buffer = `${line}\n${this.#buffer}`;
            this.#inputPaused = true;
            this.socket.pause();
          }
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

  #resumeInputIfPossible(): void {
    if (
      !this.#inputPaused
      || this.#closed
      || this.#events.size > EVENT_RESUME_WATERMARK
    ) {
      return;
    }
    this.#inputPaused = false;
    this.#consume();
    if (!this.#inputPaused && !this.#closed) this.socket.resume();
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopHeartbeat();
    this.#events.close(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.socket.destroyed) this.socket.destroy(error);
  }

  #finish(): void {
    this.#stopHeartbeat();
    const wasClosed = this.#closed;
    this.#closed = true;
    this.#events.close();
    if (!wasClosed) {
      const error = new Error("Core connection closed");
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    }
  }
}
