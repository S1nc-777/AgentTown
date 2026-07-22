import { EventEmitter } from "node:events";
import { connect as connectSocket, type Socket } from "node:net";
import { JsonLineDecoder, encodeMessage } from "./protocol.js";

type Message = Record<string, unknown>;

export type ConnectFunction = (path: string) => Socket;

export interface OpenPipeOptions {
  connect?: ConnectFunction;
  timeoutMs: number;
}

export interface ConnectCoreOptions {
  pipeName: string;
  launchCore(): void | Promise<void>;
  connect?: ConnectFunction;
  openTimeoutMs?: number;
  healthTimeoutMs?: number;
  startupDeadlineMs?: number;
  retryDelayMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 500;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_STARTUP_DEADLINE_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 100;
const connectionFlights = new Map<string, Promise<CoreClient>>();

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function openPipe(path: string, options: OpenPipeOptions): Promise<Socket> {
  const connect = options.connect ?? connectSocket;
  let socket: Socket;
  try {
    socket = connect(path);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const onConnect = () => settle();
    const onError = (error: Error) => settle(error);
    const timeout = setTimeout(
      () => settle(codedError(`pipe connection timed out after ${options.timeoutMs}ms`, "PIPE_CONNECT_TIMEOUT")),
      options.timeoutMs
    );
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export class CoreClient extends EventEmitter {
  #socket: Socket;
  #decoder = new JsonLineDecoder();
  #pending: Array<{
    expectedType: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      for (const decoded of this.#decoder.push(String(chunk))) {
        if (!decoded.ok || typeof decoded.value !== "object" || decoded.value === null) {
          this.#rejectAll(new Error("malformed core response"));
          this.close();
          return;
        }
        this.#accept(decoded.value as Message);
      }
    });
    socket.once("close", () => this.#rejectAll(new Error("core disconnected")));
    socket.once("error", (error) => this.#rejectAll(error));
  }

  #accept(message: Message) {
    if (message.type === "output" || message.type === "exit") {
      this.emit("message", message);
      return;
    }
    const index = this.#pending.findIndex(
      ({ expectedType }) => message.type === expectedType || message.type === "error"
    );
    if (index < 0) return;
    const pending = this.#pending.splice(index, 1)[0];
    if (!pending) return;
    clearTimeout(pending.timeout);
    message.type === "error"
      ? pending.reject(new Error(`core request failed: ${String(message.code)}`))
      : pending.resolve(message);
  }

  #rejectAll(error: Error) {
    for (const pending of this.#pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending = [];
  }

  request(value: object, expectedType: string, timeoutMs = 5_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#pending.findIndex((pending) => pending.timeout === timeout);
        if (index >= 0) this.#pending.splice(index, 1);
        reject(new Error(`core ${expectedType} response timed out`));
      }, timeoutMs);
      this.#pending.push({ expectedType, resolve, reject, timeout });
      this.#socket.write(encodeMessage(value));
    });
  }

  close() {
    this.#socket.destroy();
  }
}

function isPipeMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM")
  );
}

function isHealthy(message: Message): boolean {
  return (
    message.type === "health" &&
    message.status === "ok" &&
    Object.keys(message).length === 2
  );
}

async function connectHealthy(
  path: string,
  connect: ConnectFunction | undefined,
  openTimeoutMs: number,
  healthTimeoutMs: number,
  deadline?: number
): Promise<CoreClient> {
  const remainingOpenMs = deadline === undefined ? openTimeoutMs : deadline - Date.now();
  if (remainingOpenMs <= 0) {
    throw codedError("core startup deadline expired before pipe connection", "CORE_STARTUP_TIMEOUT");
  }
  const socket = await openPipe(path, {
    ...(connect ? { connect } : {}),
    timeoutMs: Math.min(openTimeoutMs, remainingOpenMs)
  });
  const client = new CoreClient(socket);
  try {
    const remainingHealthMs = deadline === undefined ? healthTimeoutMs : deadline - Date.now();
    if (remainingHealthMs <= 0) {
      throw codedError("core startup deadline expired before health response", "CORE_STARTUP_TIMEOUT");
    }
    const health = await client.request(
      { type: "health" },
      "health",
      Math.min(healthTimeoutMs, remainingHealthMs)
    );
    if (!isHealthy(health)) throw new Error("invalid core health response");
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function establishConnection(path: string, options: ConnectCoreOptions): Promise<CoreClient> {
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const startupDeadlineMs = options.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  try {
    return await connectHealthy(path, options.connect, openTimeoutMs, healthTimeoutMs);
  } catch (error) {
    if (!isPipeMissing(error)) throw error;
  }

  await options.launchCore();
  const deadline = Date.now() + startupDeadlineMs;
  let lastError: unknown = codedError("core did not become ready", "CORE_STARTUP_TIMEOUT");
  while (Date.now() < deadline) {
    try {
      return await connectHealthy(path, options.connect, openTimeoutMs, healthTimeoutMs, deadline);
    } catch (error) {
      lastError = error;
      if (isPermissionError(error)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
    }
  }
  throw codedError(
    `core startup timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    "CORE_STARTUP_TIMEOUT"
  );
}

export function connectCore(options: ConnectCoreOptions): Promise<CoreClient> {
  const path = `\\\\.\\pipe\\${options.pipeName}`;
  const existing = connectionFlights.get(path);
  if (existing) return existing;
  const flight = establishConnection(path, options);
  connectionFlights.set(path, flight);
  const clearFlight = () => {
    if (connectionFlights.get(path) === flight) connectionFlights.delete(path);
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}
