import {
  createServer,
  type Server,
  type Socket
} from "node:net";
import { createHash } from "node:crypto";
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
import type { CheckpointService } from "../lifecycle/checkpoint-service.js";

const DEFAULT_LEASE_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_CACHE_SIZE = 1_024;
const DEFAULT_BYTE_LIMIT = 1024 * 1024;
const DEFAULT_REQUEST_CACHE_BYTE_LIMIT = 4 * 1024 * 1024;
const BACKGROUND_ERROR_LIMIT = 100;
const MIN_OUTBOUND_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 128;
const PIPE_NAME_PATTERN = /^agenttown-[A-Za-z0-9-]+$/u;

type CoreServerOrchestrator = Pick<
  CompanyOrchestrator,
  "dispatch" | "start" | "stopDispatching"
>;
type CoreServerLifecycle = Pick<CheckpointService, "pause" | "recoverLatest">;

export interface CoreServerOptions {
  pipeName: string;
  store: CoreStore;
  orchestrator: CoreServerOrchestrator;
  leases: LeaseRegistry;
  lifecycle?: CoreServerLifecycle;
  leaseSweepIntervalMs?: number;
  requestCacheSize?: number;
  maxInboundQueuedBytes?: number;
  maxOutboundQueuedBytes?: number;
  maxRequestLineBytes?: number;
  requestCacheByteLimit?: number;
  onBackgroundError?: (error: Error) => void;
}

interface ClientConnection {
  socket: Socket;
  accepting: boolean;
  inboundQueuedBytes: number;
  outboundQueuedBytes: number;
  outboundIdleWaiters: Array<() => void>;
  eventStreamTerminal: boolean;
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
  bytes: number;
}

interface PendingRequest {
  fingerprint: string;
  response: Promise<IpcResponse>;
}

interface RequestTombstone {
  fingerprint: string;
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

function correlationId(value: unknown): {
  requestId: string;
  oversized: boolean;
} {
  const requestId = requestIdFrom(value, "invalid-request");
  if (Buffer.byteLength(requestId, "utf8") <= MAX_REQUEST_ID_BYTES) {
    return { requestId, oversized: false };
  }
  return { requestId: "invalid-request", oversized: true };
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
  return createHash("sha256")
    .update(request.method)
    .update("\0")
    .update(stableJson(request.params))
    .digest("hex");
}

function requestKey(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
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
  readonly #clientConnectionCounts = new Map<string, number>();
  readonly #leaseCleanupTasks = new Set<Promise<void>>();
  readonly #requestCache = new Map<string, CachedRequest>();
  readonly #requestTombstones = new Map<string, RequestTombstone>();
  readonly #completedRequestOrder = new Map<string, true>();
  readonly #pendingRequests = new Map<string, PendingRequest>();
  readonly #pipeName: string;
  readonly #store: CoreStore;
  readonly #orchestrator: CoreServerOrchestrator;
  readonly #lifecycle: CoreServerLifecycle | undefined;
  readonly #leases: LeaseRegistry;
  readonly #leaseSweepIntervalMs: number;
  readonly #requestCacheSize: number;
  readonly #maxInboundQueuedBytes: number;
  readonly #maxOutboundQueuedBytes: number;
  readonly #maxRequestLineBytes: number;
  readonly #requestCacheByteLimit: number;
  readonly #onBackgroundError: ((error: Error) => void) | undefined;
  readonly #backgroundErrors: Error[] = [];
  #requestCacheBytes = 0;
  #sweepTimer: ReturnType<typeof setInterval> | null = null;
  #listenStarted = false;
  #draining = false;
  #transportClosedPromise: Promise<void> | null = null;
  #transportClosingConnections: ClientConnection[] = [];
  #gracefulRunnerPromise: Promise<void> | null = null;
  #hardCloseRequested = false;
  readonly #hardCloseWaiters: Array<() => void> = [];
  #closePromise: Promise<void> | null = null;
  #gracefulClosePromise: Promise<void> | null = null;

  constructor(options: CoreServerOptions) {
    this.#pipeName = options.pipeName;
    this.#store = options.store;
    this.#orchestrator = options.orchestrator;
    this.#lifecycle = options.lifecycle;
    this.#leases = options.leases;
    this.#leaseSweepIntervalMs = options.leaseSweepIntervalMs
      ?? DEFAULT_LEASE_SWEEP_INTERVAL_MS;
    this.#requestCacheSize = options.requestCacheSize
      ?? DEFAULT_REQUEST_CACHE_SIZE;
    this.#maxInboundQueuedBytes = options.maxInboundQueuedBytes
      ?? DEFAULT_BYTE_LIMIT;
    this.#maxOutboundQueuedBytes = options.maxOutboundQueuedBytes
      ?? DEFAULT_BYTE_LIMIT;
    this.#maxRequestLineBytes = options.maxRequestLineBytes
      ?? DEFAULT_BYTE_LIMIT;
    this.#requestCacheByteLimit = options.requestCacheByteLimit
      ?? DEFAULT_REQUEST_CACHE_BYTE_LIMIT;
    this.#onBackgroundError = options.onBackgroundError;
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
    for (const [name, value] of [
      ["maxInboundQueuedBytes", this.#maxInboundQueuedBytes],
      ["maxRequestLineBytes", this.#maxRequestLineBytes],
      ["requestCacheByteLimit", this.#requestCacheByteLimit]
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
    if (
      !Number.isInteger(this.#maxOutboundQueuedBytes) ||
      this.#maxOutboundQueuedBytes < MIN_OUTBOUND_BYTES
    ) {
      throw new Error(
        `maxOutboundQueuedBytes must be an integer of at least ${MIN_OUTBOUND_BYTES}`
      );
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
      () => {
        void this.#leases.sweep().catch((error: unknown) => {
          this.#recordBackgroundError(error);
        });
      },
      this.#leaseSweepIntervalMs
    );
    this.#sweepTimer.unref();
  }

  closeAfterResponses(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    if (this.#gracefulClosePromise === null) {
      this.#gracefulClosePromise = this.closeTransportAfterResponses()
        .then(() => this.#waitForLeaseCleanup());
    }
    return this.#gracefulClosePromise;
  }

  closeTransportAfterResponses(): Promise<void> {
    const transportClosed = this.#ensureTransportClosing();
    if (this.#gracefulRunnerPromise === null) {
      this.#gracefulRunnerPromise = this.#runGracefulClose()
        .catch((error: unknown) => {
          this.#recordBackgroundError(error);
          this.#forceTransportClose();
        });
    }
    return transportClosed;
  }

  get backgroundErrors(): readonly Error[] {
    return [...this.#backgroundErrors];
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    const transportClosed = this.#ensureTransportClosing();
    this.#forceTransportClose();
    this.#closePromise = transportClosed
      .then(() => this.#waitForLeaseCleanup());
    return this.#closePromise;
  }

  forceCloseTransport(): void {
    void this.#ensureTransportClosing().catch((error: unknown) => {
      this.#recordBackgroundError(error);
    });
    this.#forceTransportClose();
  }

  #ensureTransportClosing(): Promise<void> {
    if (this.#transportClosedPromise !== null) {
      return this.#transportClosedPromise;
    }
    this.#draining = true;
    this.#clearSweepTimer();
    this.#transportClosingConnections = [...this.#connections];
    for (const connection of this.#transportClosingConnections) {
      this.#stopReading(connection);
    }
    const closed = this.#stopAccepting();
    this.#transportClosedPromise = Promise.all([
      closed,
      ...this.#transportClosingConnections.map((connection) =>
        connection.closed
      )
    ]).then(() => undefined);
    return this.#transportClosedPromise;
  }

  async #runGracefulClose(): Promise<void> {
    const processingDrained = Promise.all(
      this.#transportClosingConnections.map((connection) =>
        connection.processing.catch(() => undefined)
      )
    ).then(() => true);
    const shouldFinish = await Promise.race([
      processingDrained,
      this.#waitForHardClose().then(() => false)
    ]);
    if (!shouldFinish) return;
    const outboundDrained = Promise.all(
      this.#transportClosingConnections.map((connection) =>
        this.#waitForOutbound(connection)
      )
    ).then(() => true);
    const shouldEnd = await Promise.race([
      outboundDrained,
      this.#waitForHardClose().then(() => false)
    ]);
    if (!shouldEnd) return;
    for (const connection of this.#transportClosingConnections) {
      if (!connection.socket.destroyed) {
        connection.socket.end(() => connection.socket.destroy());
      }
    }
  }

  #waitForHardClose(): Promise<void> {
    if (this.#hardCloseRequested) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      this.#hardCloseWaiters.push(resolvePromise);
    });
  }

  #forceTransportClose(): void {
    if (!this.#hardCloseRequested) {
      this.#hardCloseRequested = true;
      for (const resolvePromise of this.#hardCloseWaiters.splice(0)) {
        resolvePromise();
      }
    }
    for (const connection of [...this.#connections]) {
      this.#stopReading(connection);
      connection.socket.destroy();
    }
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
    if (this.#draining) {
      socket.destroy();
      return;
    }
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    const connection: ClientConnection = {
      socket,
      accepting: true,
      inboundQueuedBytes: 0,
      outboundQueuedBytes: 0,
      outboundIdleWaiters: [],
      eventStreamTerminal: false,
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
      if (!connection.accepting) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (
        connection.inboundQueuedBytes + chunkBytes
        > this.#maxInboundQueuedBytes
      ) {
        this.#stopReading(connection);
        socket.destroy();
        return;
      }
      connection.inboundQueuedBytes += chunkBytes;
      connection.processing = connection.processing
        .then(() => this.#consume(connection, chunk))
        .catch(() => {
          socket.destroy();
        })
        .finally(() => {
          connection.inboundQueuedBytes -= chunkBytes;
        });
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      this.#detachConnection(connection);
    });
  }

  #detachConnection(connection: ClientConnection): void {
    connection.unsubscribe?.();
    connection.unsubscribe = null;
    let finalClientId: string | null = null;
    if (connection.clientId !== null) {
      const remaining =
        (this.#clientConnectionCounts.get(connection.clientId) ?? 1) - 1;
      if (remaining > 0) {
        this.#clientConnectionCounts.set(connection.clientId, remaining);
      } else {
        this.#clientConnectionCounts.delete(connection.clientId);
        finalClientId = connection.clientId;
      }
    }
    this.#connections.delete(connection);
    for (const resolvePromise of connection.outboundIdleWaiters.splice(0)) {
      resolvePromise();
    }
    connection.resolveClosed();

    if (finalClientId === null) return;
    const cleanup = this.#leases.disconnect(finalClientId)
      .catch((error: unknown) => {
        this.#recordBackgroundError(error);
      })
      .finally(() => {
        this.#leaseCleanupTasks.delete(cleanup);
      });
    this.#leaseCleanupTasks.add(cleanup);
  }

  async #waitForLeaseCleanup(): Promise<void> {
    while (this.#leaseCleanupTasks.size > 0) {
      await Promise.all([...this.#leaseCleanupTasks]);
    }
  }

  #recordBackgroundError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.#backgroundErrors.push(normalized);
    if (this.#backgroundErrors.length > BACKGROUND_ERROR_LIMIT) {
      this.#backgroundErrors.shift();
    }
    try {
      this.#onBackgroundError?.(normalized);
    } catch {
      // The original background failure remains available via backgroundErrors.
    }
  }

  async #consume(connection: ClientConnection, chunk: string): Promise<void> {
    if (!connection.accepting) return;
    connection.buffer += chunk;
    if (
      Buffer.byteLength(connection.buffer.split("\n", 1)[0] ?? "", "utf8")
      > this.#maxRequestLineBytes
    ) {
      this.#rejectAndClose(connection, errorResponse(
        "invalid-request",
        "message_too_large",
        "IPC message exceeds the maximum line size"
      ));
      return;
    }

    while (true) {
      const newlineIndex = connection.buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = connection.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      connection.buffer = connection.buffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(line, "utf8") > this.#maxRequestLineBytes) {
        this.#rejectAndClose(connection, errorResponse(
          "invalid-request",
          "message_too_large",
          "IPC message exceeds the maximum line size"
        ));
        return;
      }
      await this.#processLine(connection, line);
      if (!connection.accepting || connection.socket.destroyed) return;
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
      this.#send(connection, errorResponse(
        "invalid-json",
        "invalid_json",
        "IPC line is not valid JSON"
      ));
      return;
    }

    const correlation = correlationId(raw);
    const requestId = correlation.requestId;
    if (correlation.oversized) {
      const invalidId = errorResponse(
        requestId,
        "invalid_request_id",
        `requestId exceeds ${MAX_REQUEST_ID_BYTES} bytes`
      );
      if (
        isRecord(raw) &&
        raw.protocolVersion !== IPC_PROTOCOL_VERSION
      ) {
        this.#rejectAndClose(connection, invalidId);
      } else {
        this.#send(connection, invalidId);
      }
      return;
    }
    if (
      isRecord(raw) &&
      raw.protocolVersion !== IPC_PROTOCOL_VERSION
    ) {
      this.#rejectAndClose(connection, errorResponse(
        requestId,
        "unsupported_protocol",
        `unsupported protocol version: ${String(raw.protocolVersion)}`
      ));
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
      this.#send(connection, errorResponse(
        requestId,
        "invalid_request",
        error instanceof Error ? error.message : String(error)
      ));
      return;
    }

    if (connection.clientId === null && request.method !== "handshake") {
      this.#send(connection, errorResponse(
        request.requestId,
        "handshake_required",
        "handshake must be the first request"
      ));
      return;
    }
    const fingerprint = requestFingerprint(request);
    const cacheKey = requestKey(request.requestId);
    const cached = this.#requestCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        this.#send(connection, errorResponse(
          request.requestId,
          "request_id_conflict",
          "request ID was already used for different method or params"
        ));
      } else {
        const localError = cached.response.ok
          ? this.#applyReplayLocalEffects(connection, request)
          : null;
        if (localError !== null) {
          this.#send(connection, localError);
          return;
        }
        if (cached.response.error?.code === "unsupported_protocol") {
          this.#rejectAndClose(connection, cached.response);
        } else {
          this.#send(connection, cached.response);
        }
        if (request.method === "handshake" && cached.response.ok) {
          this.#startEventSubscription(connection);
        }
      }
      return;
    }

    const tombstone = this.#requestTombstones.get(cacheKey);
    if (tombstone !== undefined) {
      this.#send(connection, tombstone.fingerprint === fingerprint
        ? errorResponse(
          request.requestId,
          "replay_unavailable",
          "request completed but its response is no longer available"
        )
        : errorResponse(
          request.requestId,
          "request_id_conflict",
          "request ID was already used for different method or params"
        ));
      return;
    }

    const pending = this.#pendingRequests.get(cacheKey);
    if (pending !== undefined) {
      if (pending.fingerprint !== fingerprint) {
        this.#send(connection, errorResponse(
          request.requestId,
          "request_id_conflict",
          "request ID is in flight with different method or params"
        ));
        return;
      }
      const response = await pending.response;
      const localError = response.ok
        ? this.#applyReplayLocalEffects(connection, request)
        : null;
      if (localError !== null) {
        this.#send(connection, localError);
        return;
      }
      if (response.error?.code === "unsupported_protocol") {
        this.#rejectAndClose(connection, response);
      } else {
        this.#send(connection, response);
      }
      if (request.method === "handshake" && response.ok) {
        this.#startEventSubscription(connection);
      }
      return;
    }

    const responsePromise = this.#respond(connection, request)
      .then((response) => this.#boundedResponse(response));
    const requestFlight = { fingerprint, response: responsePromise };
    this.#pendingRequests.set(cacheKey, requestFlight);
    let response: IpcResponse;
    try {
      response = await responsePromise;
    } finally {
      if (this.#pendingRequests.get(cacheKey) === requestFlight) {
        this.#pendingRequests.delete(cacheKey);
      }
    }
    this.#cache(cacheKey, { fingerprint, response });
    if (response.error?.code === "unsupported_protocol") {
      this.#rejectAndClose(connection, response);
    } else {
      this.#send(connection, response);
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
        return this.#heartbeat(connection, request.params);
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
      case "status.snapshot": {
        return this.#statusSnapshot(requiredString(request.params, "companyId"));
      }
      case "company.start":
        await this.#orchestrator.start(
          stringRecord(request.params.scenarios ?? {}, "scenarios")
        );
        return { status: "running" };
      case "company.pause":
        if (this.#lifecycle === undefined) {
          await this.#orchestrator.stopDispatching();
          return { status: "pausing" };
        }
        await this.#lifecycle.pause("user_requested");
        setImmediate(() => {
          void this.closeTransportAfterResponses().catch((error: unknown) => {
            this.#recordBackgroundError(error);
          });
        });
        return { status: "paused" };
      case "company.resume":
        if (this.#lifecycle === undefined) {
          await this.#orchestrator.start(
            stringRecord(request.params.scenarios ?? {}, "scenarios")
          );
          return { status: "running" };
        }
        const recovery = await this.#lifecycle.recoverLatest();
        return {
          status: "running",
          decisions: recovery.decisions
        };
      case "company.stop":
        if (this.#lifecycle !== undefined) {
          await this.#lifecycle.pause("shutdown");
          setImmediate(() => {
            void this.closeTransportAfterResponses().catch((error: unknown) => {
              this.#recordBackgroundError(error);
            });
          });
          return { status: "stopped" };
        }
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

  #statusSnapshot(companyId: string): Record<string, unknown> {
    const company = this.#store.getCompany(companyId);
    if (company === null) {
      throw new RequestError("not_found", `company not found: ${companyId}`);
    }
    const tasks = this.#store.listTasks(companyId);
    const events = this.#store.listEvents(0);
    const sessions = new Map(
      this.#store.listSessions(companyId).map((session) => [
        session.employeeId,
        session
      ])
    );
    const employees = this.#store.listEmployees(companyId).map((employee) => {
      const currentTask = tasks.find((task) =>
        task.ownerEmployeeId === employee.id
        && (task.status === "running" || task.status === "review")
      );
      return {
        ...employee,
        status: sessions.get(employee.id)?.status ?? "not_started",
        currentTaskId: currentTask?.id ?? null,
        usage: this.#store.latestUsage(companyId, employee.id) ?? {
          inputTokens: null,
          outputTokens: null,
          contextTokens: null,
          capturedAt: "1970-01-01T00:00:00.000Z"
        }
      };
    });
    return {
      companyId,
      status: company.status,
      activeTaskCount: tasks.filter(
        (task) => task.status === "running" || task.status === "review"
      ).length,
      pendingApprovalCount: events.filter(
        (event) => event.type === "user.approval.requested"
      ).length,
      employees
    };
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
    if (connection.clientId === null) {
      this.#clientConnectionCounts.set(
        clientId,
        (this.#clientConnectionCounts.get(clientId) ?? 0) + 1
      );
      connection.clientId = clientId;
    }
    connection.afterSequence = afterSequence;
    this.#leases.heartbeat(clientId);
    return {
      protocolVersion: IPC_PROTOCOL_VERSION,
      coreVersion: "0.0.0",
      leaseTtlMs: this.#leases.ttlMs,
      capabilities: {
        eventReplay: true,
        clientLeases: true
      }
    };
  }

  #heartbeat(
    connection: ClientConnection,
    params: Record<string, unknown>
  ): Record<string, boolean> {
    if (connection.clientId === null) {
      throw new RequestError("handshake_required", "client is not handshaken");
    }
    const requestedClientId = params.clientId;
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

  #applyReplayLocalEffects(
    connection: ClientConnection,
    request: IpcRequest
  ): IpcResponse | null {
    try {
      if (request.method === "handshake") {
        this.#handshake(connection, request.params);
      } else if (request.method === "client.heartbeat") {
        this.#heartbeat(connection, request.params);
      }
      return null;
    } catch (error) {
      return error instanceof RequestError
        ? errorResponse(request.requestId, error.code, error.message)
        : errorResponse(
          request.requestId,
          "request_failed",
          error instanceof Error ? error.message : String(error)
        );
    }
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
    if (
      connection.eventStreamTerminal ||
      event.sequence <= connection.afterSequence
    ) {
      return;
    }
    const message = ipcEvent(event);
    if (this.#messageBytes(message) > this.#maxOutboundQueuedBytes) {
      this.#terminateEventStream(connection, event.sequence);
      return;
    }
    if (this.#send(connection, message)) {
      connection.afterSequence = event.sequence;
    }
  }

  #cache(
    cacheKey: string,
    cached: Omit<CachedRequest, "bytes">
  ): void {
    const bytes = cacheKey.length
      + cached.fingerprint.length
      + Buffer.byteLength(JSON.stringify(cached.response), "utf8");
    const previous = this.#requestCache.get(cacheKey);
    if (previous !== undefined) this.#requestCacheBytes -= previous.bytes;
    this.#requestCache.delete(cacheKey);
    this.#requestTombstones.delete(cacheKey);
    this.#completedRequestOrder.delete(cacheKey);
    this.#completedRequestOrder.set(cacheKey, true);

    if (bytes <= this.#requestCacheByteLimit) {
      this.#requestCache.set(cacheKey, { ...cached, bytes });
      this.#requestCacheBytes += bytes;
    } else {
      this.#requestTombstones.set(cacheKey, {
        fingerprint: cached.fingerprint
      });
    }

    while (this.#requestCacheBytes > this.#requestCacheByteLimit) {
      const oldestCachedKey = [...this.#completedRequestOrder.keys()]
        .find((key) => this.#requestCache.has(key));
      if (oldestCachedKey === undefined) break;
      const evicted = this.#requestCache.get(oldestCachedKey);
      this.#requestCache.delete(oldestCachedKey);
      if (evicted !== undefined) {
        this.#requestCacheBytes -= evicted.bytes;
        this.#requestTombstones.set(oldestCachedKey, {
          fingerprint: evicted.fingerprint
        });
      }
    }

    while (this.#completedRequestOrder.size > this.#requestCacheSize) {
      const oldest = this.#completedRequestOrder.keys().next().value as string
        | undefined;
      if (oldest === undefined) break;
      this.#completedRequestOrder.delete(oldest);
      const evicted = this.#requestCache.get(oldest);
      this.#requestCache.delete(oldest);
      this.#requestTombstones.delete(oldest);
      if (evicted !== undefined) this.#requestCacheBytes -= evicted.bytes;
    }
  }

  #send(
    connection: ClientConnection,
    message: IpcEvent | IpcResponse
  ): boolean {
    if (connection.socket.destroyed) return false;
    let outbound = message;
    if (
      message.kind === "response" &&
      this.#messageBytes(message) > this.#maxOutboundQueuedBytes
    ) {
      outbound = this.#boundedResponse(message);
    } else if (
      message.kind === "event" &&
      this.#messageBytes(message) > this.#maxOutboundQueuedBytes
    ) {
      this.#terminateEventStream(connection, message.sequence);
      return false;
    }
    const encoded = `${JSON.stringify(outbound)}\n`;
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (
      bytes > this.#maxOutboundQueuedBytes ||
      connection.outboundQueuedBytes + bytes > this.#maxOutboundQueuedBytes
    ) {
      this.#stopReading(connection);
      connection.socket.destroy();
      return false;
    }
    connection.outboundQueuedBytes += bytes;
    connection.socket.write(encoded, () => {
      connection.outboundQueuedBytes -= bytes;
      if (connection.outboundQueuedBytes === 0) {
        for (const resolvePromise of connection.outboundIdleWaiters.splice(0)) {
          resolvePromise();
        }
      }
    });
    return true;
  }

  #terminateEventStream(
    connection: ClientConnection,
    sequence: number
  ): void {
    if (connection.eventStreamTerminal || connection.socket.destroyed) return;
    connection.eventStreamTerminal = true;
    connection.unsubscribe?.();
    connection.unsubscribe = null;
    this.#stopReading(connection);
    const terminal: IpcEvent = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      kind: "event",
      sequence,
      type: "ipc.stream_error",
      payload: { code: "event_too_large" }
    };
    const encoded = `${JSON.stringify(terminal)}\n`;
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (bytes > this.#maxOutboundQueuedBytes) {
      connection.socket.destroy();
      return;
    }

    // One fixed-size terminal event is reserved beyond the normal queue budget.
    connection.outboundQueuedBytes += bytes;
    connection.socket.write(encoded, () => {
      connection.outboundQueuedBytes -= bytes;
      if (connection.outboundQueuedBytes === 0) {
        for (const resolvePromise of connection.outboundIdleWaiters.splice(0)) {
          resolvePromise();
        }
      }
      if (!connection.socket.destroyed) {
        connection.socket.end();
        connection.socket.resume();
      }
    });
  }

  #messageBytes(message: IpcEvent | IpcResponse): number {
    return Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8");
  }

  #boundedResponse(response: IpcResponse): IpcResponse {
    if (
      Buffer.byteLength(response.requestId, "utf8") > MAX_REQUEST_ID_BYTES
    ) {
      return errorResponse(
        "invalid-request",
        "invalid_request_id",
        `requestId exceeds ${MAX_REQUEST_ID_BYTES} bytes`
      );
    }
    if (this.#messageBytes(response) <= this.#maxOutboundQueuedBytes) {
      return response;
    }
    return errorResponse(
      response.requestId,
      "response_too_large",
      "response exceeds the maximum outbound message size"
    );
  }

  #waitForOutbound(connection: ClientConnection): Promise<void> {
    if (
      connection.outboundQueuedBytes === 0 ||
      connection.socket.destroyed
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise) => {
      connection.outboundIdleWaiters.push(resolvePromise);
    });
  }

  #stopReading(connection: ClientConnection): void {
    if (!connection.accepting) return;
    connection.accepting = false;
    connection.buffer = "";
    connection.socket.pause();
  }

  #rejectAndClose(
    connection: ClientConnection,
    response: IpcResponse
  ): void {
    this.#stopReading(connection);
    this.#send(connection, response);
    connection.socket.end();
  }
}
