import {
  createServer,
  type Server,
  type Socket
} from "node:net";
import {
  IPC_PROTOCOL_VERSION,
  parseActionProposal,
  parseIpcMessage,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse
} from "@agenttown/runtime-contract";
import type { CompanyOrchestrator } from "../company/orchestrator.js";
import {
  CoreStore,
  type EventRecord
} from "../storage/core-store.js";
import { LeaseRegistry } from "./lease-registry.js";

const DEFAULT_LEASE_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_CACHE_SIZE = 1_024;
const MAX_LINE_BYTES = 1024 * 1024;
const PIPE_NAME_PATTERN = /^agenttown-[A-Za-z0-9-]+$/u;

type CoreServerOrchestrator = Pick<
  CompanyOrchestrator,
  "dispatch" | "start" | "stopDispatching"
>;

export interface CoreServerOptions {
  pipeName: string;
  store: CoreStore;
  orchestrator: CoreServerOrchestrator;
  leases: LeaseRegistry;
  leaseSweepIntervalMs?: number;
  requestCacheSize?: number;
}

interface ClientConnection {
  socket: Socket;
  clientId: string | null;
  buffer: string;
  afterSequence: number;
  unsubscribe: (() => void) | null;
  processing: Promise<void>;
  closed: Promise<void>;
  resolveClosed: () => void;
}

interface CachedRequest {
  fingerprint: string;
  response: IpcResponse;
}

interface PendingRequest {
  fingerprint: string;
  response: Promise<IpcResponse>;
}

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFrom(value: unknown, fallback: string): string {
  if (isRecord(value) && typeof value.requestId === "string") {
    return value.requestId.length > 0 ? value.requestId : fallback;
  }
  return fallback;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(request: IpcRequest): string {
  return `${request.method}\0${stableJson(request.params)}`;
}

function requiredString(
  params: Record<string, unknown>,
  key: string
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestError("invalid_params", `${key} must be a non-empty string`);
  }
  return value;
}

function nonnegativeInteger(
  value: unknown,
  label: string,
  defaultValue?: number
): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RequestError(
      "invalid_params",
      `${label} must be a nonnegative integer`
    );
  }
  return value as number;
}

function stringRecord(
  value: unknown,
  label: string
): Readonly<Record<string, string>> {
  if (
    !isRecord(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new RequestError(
      "invalid_params",
      `${label} must be an object of strings`
    );
  }
  return value as Record<string, string>;
}

function successResponse(requestId: string, result: unknown): IpcResponse {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: true,
    result,
    error: null
  };
}

function errorResponse(
  requestId: string,
  code: string,
  message: string
): IpcResponse {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    kind: "response",
    requestId,
    ok: false,
    result: null,
    error: { code, message }
  };
}

function ipcEvent(event: EventRecord): IpcEvent {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    kind: "event",
    sequence: event.sequence,
    type: event.type,
    payload: {
      ...event.payload,
      eventId: event.id,
      occurredAt: event.occurredAt,
      actorId: event.actorId,
      taskId: event.taskId,
      causationEventId: event.causationEventId
    }
  };
}

export class CoreServer {
  readonly #server: Server;
  readonly #connections = new Set<ClientConnection>();
  readonly #requestCache = new Map<string, CachedRequest>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pipeName: string;
  readonly #store: CoreStore;
  readonly #orchestrator: CoreServerOrchestrator;
  readonly #leases: LeaseRegistry;
  readonly #leaseSweepIntervalMs: number;
  readonly #requestCacheSize: number;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #listenStarted = false;
  #closePromise: Promise<void> | null = null;
  #gracefulClosePromise: Promise<void> | null = null;

  constructor(options: CoreServerOptions) {
    this.#pipeName = options.pipeName;
    this.#store = options.store;
    this.#orchestrator = options.orchestrator;
    this.#leases = options.leases;
    this.#leaseSweepIntervalMs = options.leaseSweepIntervalMs
      ?? DEFAULT_LEASE_SWEEP_INTERVAL_MS;
    this.#requestCacheSize = options.requestCacheSize
      ?? DEFAULT_REQUEST_CACHE_SIZE;
    if (
      !Number.isInteger(this.#leaseSweepIntervalMs) ||
      this.#leaseSweepIntervalMs <= 0
    ) {
      throw new Error("leaseSweepIntervalMs must be a positive integer");
    }
    if (
      !Number.isInteger(this.#requestCacheSize) ||
      this.#requestCacheSize <= 0
    ) {
      throw new Error("requestCacheSize must be a positive integer");
    }
    this.#server = createServer((socket) => this.#accept(socket));
  }

  async listen(): Promise<void> {
    if (this.#listenStarted) throw new Error("CoreServer.listen called twice");
    this.#listenStarted = true;
    if (
      !PIPE_NAME_PATTERN.test(this.#pipeName) ||
      this.#pipeName.length > 128
    ) {
      throw new Error("pipeName must be a safe AgentTown name");
    }
    if (process.platform !== "win32") {
      throw new Error("CoreServer Named Pipe IPC requires Windows");
    }

    this.#leases.initialize();
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => {
        this.#server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#server.off("error", onError);
        resolvePromise();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(pipePath(this.#pipeName));
    });
    this.#server.on("error", () => undefined);
    this.#sweepTimer = setInterval(
      () => this.#leases.sweep(),
      this.#leaseSweepIntervalMs
    );
    this.#sweepTimer.unref();
  }

  closeAfterResponses(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#gracefulClosePromise !== null) return this.#gracefulClosePromise;
    this.#gracefulClosePromise = this.#closeGracefully();
    return this.#gracefulClosePromise;
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#clearSweepTimer();
    const connections = [...this.#connections];
    const closed = this.#stopAccepting();
    for (const connection of connections) {
      connection.socket.destroy();
    }
    this.#closePromise = Promise.all([
      closed,
      ...connections.map((connection) => connection.closed)
    ]).then(() => undefined);
    return this.#closePromise;
  }

  async #closeGracefully(): Promise<void> {
    this.#clearSweepTimer();
    const closed = this.#stopAccepting();
    const connections = [...this.#connections];
    await Promise.all(
      connections.map((connection) =>
        connection.processing.catch(() => undefined)
      )
    );
    for (const connection of connections) {
      if (!connection.socket.destroyed) connection.socket.end();
    }
    await Promise.all([
      closed,
      ...connections.map((connection) => connection.closed)
    ]);
  }

  #stopAccepting(): Promise<void> {
    if (!this.#server.listening) return Promise.resolve();
    return new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolvePromise();
        else reject(error);
      });
    });
  }

  #clearSweepTimer(): void {
    if (this.#sweepTimer === null) return;
    clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  #accept(socket: Socket): void {
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    const connection: ClientConnection = {
      socket,
      clientId: null,
      buffer: "",
      afterSequence: 0,
      unsubscribe: null,
      processing: Promise.resolve(),
      closed,
      resolveClosed
    };
    this.#connections.add(connection);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("data", (chunk: string) => {
      connection.processing = connection.processing
        .then(() => this.#consume(connection, chunk))
        .catch(() => {
          socket.destroy();
        });
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      try {
        this.#connections.delete(connection);
        connection.unsubscribe?.();
        connection.unsubscribe = null;
        if (connection.clientId !== null) {
          this.#leases.disconnect(connection.clientId);
        }
      } finally {
        connection.resolveClosed();
      }
    });
  }

  async #consume(connection: ClientConnection, chunk: string): Promise<void> {
    connection.buffer += chunk;
    if (Buffer.byteLength(connection.buffer, "utf8") > MAX_LINE_BYTES) {
      this.#send(connection.socket, errorResponse(
        "invalid-request",
        "message_too_large",
        "IPC message exceeds the maximum line size"
      ));
      connection.socket.end();
      return;
    }

    while (true) {
      const newlineIndex = connection.buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = connection.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      connection.buffer = connection.buffer.slice(newlineIndex + 1);
      await this.#processLine(connection, line);
      if (connection.socket.destroyed) return;
    }
  }

  async #processLine(
    connection: ClientConnection,
    line: string
  ): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#send(connection.socket, errorResponse(
        "invalid-json",
        "invalid_json",
        "IPC line is not valid JSON"
      ));
      return;
    }

    const requestId = requestIdFrom(raw, "invalid-request");
    if (
      isRecord(raw) &&
      raw.protocolVersion !== IPC_PROTOCOL_VERSION
    ) {
      this.#send(connection.socket, errorResponse(
        requestId,
        "unsupported_protocol",
        `unsupported protocol version: ${String(raw.protocolVersion)}`
      ));
      connection.socket.end();
      return;
    }

    let request: IpcRequest;
    try {
      const message = parseIpcMessage(raw);
      if (message.kind !== "request") {
        throw new Error("expected an IPC request");
      }
      request = message;
    } catch (error) {
      this.#send(connection.socket, errorResponse(
        requestId,
        "invalid_request",
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }

    if (connection.clientId === null && request.method !== "handshake") {
      this.#send(connection.socket, errorResponse(
        request.requestId,
        "handshake_required",
        "handshake must be the first request"
      ));
      return;
    }

    const fingerprint = requestFingerprint(request);
    const cached = this.#requestCache.get(request.requestId);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        this.#send(connection.socket, errorResponse(
          request.requestId,
          "request_id_conflict",
          "request ID was already used for different method or params"
        ));
      } else {
        if (request.method === "handshake" && cached.response.ok) {
          try {
            this.#handshake(connection, request.params);
          } catch (error) {
            const response = error instanceof RequestError
              ? errorResponse(request.requestId, error.code, error.message)
              : errorResponse(
                request.requestId,
                "request_failed",
                error instanceof Error ? error.message : String(error)
              );
            this.#send(connection.socket, response);
            return;
          }
        }
        this.#send(connection.socket, cached.response);
        if (cached.response.error?.code === "unsupported_protocol") {
          connection.socket.end();
        }
        if (request.method === "handshake" && cached.response.ok) {
          this.#startEventSubscription(connection);
        }
      }
      return;
    }

    const pending = this.#pendingRequests.get(request.requestId);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) {
        this.#send(connection.socket, errorResponse(
          request.requestId,
          "request_id_conflict",
          "request ID is in flight with different method or params"
        ));
        return;
      }
      const response = await pending.response;
      if (request.method === "handshake" && response.ok) {
        try {
          this.#handshake(connection, request.params);
        } catch (error) {
          const handshakeError = error instanceof RequestError
            ? errorResponse(request.requestId, error.code, error.message)
            : errorResponse(
              request.requestId,
              "request_failed",
              error instanceof Error ? error.message : String(error)
            );
          this.#send(connection.socket, handshakeError);
          return;
        }
      }
      this.#send(connection.socket, response);
      if (response.error?.code === "unsupported_protocol") {
        connection.socket.end();
      }
      if (request.method === "handshake" && response.ok) {
        this.#startEventSubscription(connection);
      }
      return;
    }

    const responsePromise = this.#respond(connection, request);
    const requestFlight = { fingerprint, response: responsePromise };
    this.#pendingRequests.set(request.requestId, requestFlight);
    let response: IpcResponse;
    try {
      response = await responsePromise;
    } finally {
      if (this.#pendingRequests.get(request.requestId) === requestFlight) {
        this.#pendingRequests.delete(request.requestId);
      }
    }
    this.#cache(request.requestId, { fingerprint, response });
    this.#send(connection.socket, response);
    if (response.error?.code === "unsupported_protocol") {
      connection.socket.end();
    }
    if (response.ok && request.method === "handshake") {
      this.#startEventSubscription(connection);
    }
  }

  async #respond(
    connection: ClientConnection,
    request: IpcRequest
  ): Promise<IpcResponse> {
    try {
      return successResponse(
        request.requestId,
        await this.#dispatch(connection, request)
      );
    } catch (error) {
      if (error instanceof RequestError) {
        return errorResponse(request.requestId, error.code, error.message);
      }
      return errorResponse(
        request.requestId,
        "request_failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async #dispatch(
    connection: ClientConnection,
    request: IpcRequest
  ): Promise<unknown> {
    switch (request.method) {
      case "handshake":
        return this.#handshake(connection, request.params);
      case "client.heartbeat": {
        if (connection.clientId === null) {
          throw new RequestError("handshake_required", "client is not handshaken");
        }
        const requestedClientId = request.params.clientId;
        if (
          requestedClientId !== undefined &&
          requestedClientId !== connection.clientId
        ) {
          throw new RequestError(
            "invalid_params",
            "heartbeat clientId does not match the connection"
          );
        }
        this.#leases.heartbeat(connection.clientId);
        return { renewed: true };
      }
      case "company.status": {
        const companyId = request.params.companyId;
        if (companyId === undefined) return null;
        if (typeof companyId !== "string" || companyId.length === 0) {
          throw new RequestError(
            "invalid_params",
            "companyId must be a non-empty string"
          );
        }
        return this.#store.getCompany(companyId);
      }
      case "company.start":
        await this.#orchestrator.start(
          stringRecord(request.params.scenarios ?? {}, "scenarios")
        );
        return { status: "running" };
      case "company.pause":
        await this.#orchestrator.stopDispatching();
        return { status: "pausing" };
      case "company.resume":
        await this.#orchestrator.start(
          stringRecord(request.params.scenarios ?? {}, "scenarios")
        );
        return { status: "running" };
      case "company.stop":
        await this.#orchestrator.stopDispatching();
        return { status: "stopping" };
      case "tasks.list":
        return this.#store.listTasks(requiredString(request.params, "companyId"));
      case "events.list":
        return this.#store.listEvents(nonnegativeInteger(
          request.params.afterSequence,
          "afterSequence",
          0
        ));
      case "action.dispatch": {
        let action;
        try {
          action = parseActionProposal(request.params.action);
        } catch (error) {
          throw new RequestError(
            "invalid_action",
            error instanceof Error ? error.message : String(error)
          );
        }
        await this.#orchestrator.dispatch(action);
        return { dispatched: true };
      }
      default:
        throw new RequestError(
          "unknown_method",
          `unknown IPC method: ${request.method}`
        );
    }
  }

  #handshake(
    connection: ClientConnection,
    params: Record<string, unknown>
  ): Record<string, unknown> {
    if (params.protocolVersion !== IPC_PROTOCOL_VERSION) {
      throw new RequestError(
        "unsupported_protocol",
        `unsupported protocol version: ${String(params.protocolVersion)}`
      );
    }
    const clientId = requiredString(params, "clientId");
    const afterSequence = nonnegativeInteger(
      params.afterSequence,
      "afterSequence"
    );
    if (
      connection.clientId !== null &&
      connection.clientId !== clientId
    ) {
      throw new RequestError(
        "already_handshaken",
        "connection is already assigned to a different client"
      );
    }
    connection.clientId = clientId;
    connection.afterSequence = afterSequence;
    this.#leases.heartbeat(clientId);
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      coreVersion: "0.0.0",
      capabilities: {
        eventReplay: true,
        clientLeases: true
      }
    };
  }

  #startEventSubscription(connection: ClientConnection): void {
    connection.unsubscribe?.();
    connection.unsubscribe = this.#store.subscribeEvents((event) => {
      this.#forwardEvent(connection, event);
    });
    for (const event of this.#store.listEvents(connection.afterSequence)) {
      this.#forwardEvent(connection, event);
    }
  }

  #forwardEvent(
    connection: ClientConnection,
    event: EventRecord
  ): void {
    if (event.sequence <= connection.afterSequence) return;
    connection.afterSequence = event.sequence;
    this.#send(connection.socket, ipcEvent(event));
  }

  #cache(requestId: string, cached: CachedRequest): void {
    this.#requestCache.set(requestId, cached);
    while (this.#requestCache.size > this.#requestCacheSize) {
      const oldest = this.#requestCache.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#requestCache.delete(oldest);
    }
  }

  #send(socket: Socket, message: IpcEvent | IpcResponse): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(message)}\n`);
  }
}
