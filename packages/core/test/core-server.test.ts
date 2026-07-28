import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type {
  ActionProposal,
  IpcEvent,
  IpcResponse
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreServer,
  type CoreServerOptions
} from "../src/ipc/core-server.js";
import { LeaseRegistry } from "../src/ipc/lease-registry.js";
import { CoreStore } from "../src/storage/core-store.js";
import { companyDefinitionFixture } from "./helpers.js";

type WireMessage = IpcEvent | IpcResponse;

interface MessageWaiter {
  predicate: (message: WireMessage) => boolean;
  resolve: (message: WireMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function pipePath(pipeName: string): string {
  return `\\\\.\\pipe\\${pipeName}`;
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

class TestClient {
  readonly #socket: Socket;
  readonly #messages: WireMessage[] = [];
  readonly #waiters: MessageWaiter[] = [];
  #buffer = "";
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      const lines = this.#buffer.split("\n");
      this.#buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        this.#accept(JSON.parse(line) as WireMessage);
      }
    });
    socket.once("close", () => {
      this.#closed = true;
      this.#rejectAll(new Error("test client closed"));
    });
    socket.on("error", (error) => {
      this.#rejectAll(error);
    });
  }

  static connect(pipeName: string): Promise<TestClient> {
    return new Promise<TestClient>((resolvePromise, reject) => {
      const socket = connect(pipePath(pipeName));
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolvePromise(new TestClient(socket));
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  request(
    method: string,
    params: Record<string, unknown>
  ): Promise<IpcResponse> {
    return this.requestWithId(randomUUID(), method, params);
  }

  requestWithId(
    requestId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<IpcResponse> {
    this.sendRaw(`${JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      requestId,
      method,
      params
    })}\n`);
    return this.#waitFor(
      (message): message is IpcResponse =>
        message.kind === "response" && message.requestId === requestId
    );
  }

  handshake(
    clientId = "client-a",
    afterSequence = 0
  ): Promise<IpcResponse> {
    return this.request("handshake", {
      clientId,
      protocolVersion: 1,
      afterSequence
    });
  }

  nextEvent(): Promise<IpcEvent> {
    return this.#waitFor(
      (message): message is IpcEvent => message.kind === "event"
    );
  }

  nextResponse(code: string): Promise<IpcResponse> {
    return this.#waitFor(
      (message): message is IpcResponse =>
        message.kind === "response" && message.error?.code === code
    );
  }

  sendRaw(text: string): void {
    this.#socket.write(text);
  }

  sendBatch(lines: readonly string[]): void {
    this.#socket.cork();
    for (const line of lines) this.#socket.write(line);
    this.#socket.uncork();
  }

  waitForClose(timeoutMs = 2_000): Promise<void> {
    if (this.#closed) return Promise.resolve();
    return new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.#socket.off("close", onClose);
        reject(new Error("timed out waiting for IPC socket close"));
      }, timeoutMs);
      const onClose = () => {
        clearTimeout(timeout);
        resolvePromise();
      };
      this.#socket.once("close", onClose);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    const closed = this.waitForClose();
    this.#socket.destroy();
    await closed;
  }

  #accept(message: WireMessage): void {
    const waiterIndex = this.#waiters.findIndex((waiter) =>
      waiter.predicate(message)
    );
    if (waiterIndex < 0) {
      this.#messages.push(message);
      return;
    }
    const waiter = this.#waiters.splice(waiterIndex, 1)[0];
    if (waiter === undefined) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(message);
  }

  #waitFor<T extends WireMessage>(
    predicate: (message: WireMessage) => message is T,
    timeoutMs = 2_000
  ): Promise<T> {
    const messageIndex = this.#messages.findIndex(predicate);
    if (messageIndex >= 0) {
      const message = this.#messages.splice(messageIndex, 1)[0];
      if (message !== undefined && predicate(message)) {
        return Promise.resolve(message);
      }
    }
    return new Promise<T>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex(
          (waiter) => waiter.timeout === timeout
        );
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error("timed out waiting for IPC message"));
      }, timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (message) => resolvePromise(message as T),
        reject,
        timeout
      });
    });
  }

  #rejectAll(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

class RecordingOrchestrator {
  readonly starts: Array<Readonly<Record<string, string>>> = [];
  readonly actions: ActionProposal[] = [];
  stopDispatchingCalls = 0;

  async start(scenarios: Readonly<Record<string, string>>): Promise<void> {
    this.starts.push(scenarios);
  }

  async dispatch(action: ActionProposal): Promise<void> {
    this.actions.push(action);
  }

  async stopDispatching(): Promise<void> {
    this.stopDispatchingCalls += 1;
  }
}

class BlockingOrchestrator extends RecordingOrchestrator {
  readonly started: Promise<void>;
  #resolveStarted: (() => void) | undefined;
  #resolveStart: (() => void) | undefined;

  constructor() {
    super();
    this.started = new Promise<void>((resolvePromise) => {
      this.#resolveStarted = resolvePromise;
    });
  }

  override async start(
    scenarios: Readonly<Record<string, string>>
  ): Promise<void> {
    this.starts.push(scenarios);
    this.#resolveStarted?.();
    await new Promise<void>((resolvePromise) => {
      this.#resolveStart = resolvePromise;
    });
  }

  release(): void {
    this.#resolveStart?.();
  }
}

class SharedGateOrchestrator extends RecordingOrchestrator {
  readonly started: Promise<void>;
  readonly #gate: Promise<void>;
  #resolveStarted: (() => void) | undefined;
  #release: (() => void) | undefined;

  constructor() {
    super();
    this.started = new Promise<void>((resolvePromise) => {
      this.#resolveStarted = resolvePromise;
    });
    this.#gate = new Promise<void>((resolvePromise) => {
      this.#release = resolvePromise;
    });
  }

  override async start(
    scenarios: Readonly<Record<string, string>>
  ): Promise<void> {
    this.starts.push(scenarios);
    this.#resolveStarted?.();
    await this.#gate;
  }

  release(): void {
    this.#release?.();
  }
}

const servers: CoreServer[] = [];
const clients: TestClient[] = [];
const stores: CoreStore[] = [];

function createStore(): CoreStore {
  const store = new CoreStore(":memory:");
  store.initialize();
  stores.push(store);
  return store;
}

function createLeases(
  store: CoreStore,
  onLastClientExpired: () => void | Promise<void> = () => undefined
): LeaseRegistry {
  return new LeaseRegistry(store, {
    ttlMs: 5_000,
    now: () => 1_000,
    onLastClientExpired
  });
}

async function createServer(input?: {
  store?: CoreStore;
  orchestrator?: RecordingOrchestrator;
  leases?: LeaseRegistry;
  serverOptions?: Partial<Pick<
    CoreServerOptions,
    | "maxInboundQueuedBytes"
    | "maxOutboundQueuedBytes"
    | "maxRequestLineBytes"
    | "requestCacheByteLimit"
    | "leaseSweepIntervalMs"
    | "onBackgroundError"
  >>;
}): Promise<{
  pipeName: string;
  server: CoreServer;
  store: CoreStore;
  orchestrator: RecordingOrchestrator;
  leases: LeaseRegistry;
}> {
  const pipeName = `agenttown-test-${randomUUID()}`;
  const store = input?.store ?? createStore();
  const orchestrator = input?.orchestrator ?? new RecordingOrchestrator();
  const leases = input?.leases ?? createLeases(store);
  const server = new CoreServer({
    pipeName,
    store,
    orchestrator,
    leases,
    leaseSweepIntervalMs: 10_000,
    requestCacheSize: 16,
    ...input?.serverOptions
  });
  servers.push(server);
  await server.listen();
  return { pipeName, server, store, orchestrator, leases };
}

async function connectClient(pipeName: string): Promise<TestClient> {
  const client = await TestClient.connect(pipeName);
  clients.push(client);
  return client;
}

function storeTestEvent(store: CoreStore, type: string): void {
  store.insertEvent({
    id: randomUUID(),
    type,
    actorId: "test",
    taskId: null,
    causationEventId: null,
    payload: {}
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close().catch(() => undefined);
  }
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined);
  }
  for (const store of stores.splice(0)) store.close();
});

describe.runIf(process.platform === "win32")("CoreServer", () => {
  it("handshakes, replays and streams events, and replays duplicate requests", async () => {
    const { pipeName, store } = await createServer();
    storeTestEvent(store, "event-before-handshake");
    const client = await connectClient(pipeName);

    await expect(client.handshake()).resolves.toMatchObject({
      ok: true,
      result: {
        protocolVersion: 1
      }
    });
    await expect(client.nextEvent()).resolves.toMatchObject({
      kind: "event",
      sequence: 1,
      type: "event-before-handshake"
    });

    const first = await client.requestWithId("same-id", "company.status", {});
    const second = await client.requestWithId("same-id", "company.status", {});
    expect(second).toEqual(first);

    storeTestEvent(store, "event-after-handshake");
    await expect(client.nextEvent()).resolves.toMatchObject({
      kind: "event",
      type: "event-after-handshake"
    });
  });

  it("re-establishes a client lease when a handshake request is replayed", async () => {
    const { pipeName } = await createServer();
    const params = {
      clientId: "client-reconnect",
      protocolVersion: 1,
      afterSequence: 0
    };
    const first = await connectClient(pipeName);
    await first.requestWithId("replayed-handshake", "handshake", params);
    await first.close();

    const second = await connectClient(pipeName);
    await expect(second.requestWithId(
      "replayed-handshake",
      "handshake",
      params
    )).resolves.toMatchObject({ ok: true });
    await expect(second.request("company.status", {})).resolves.toMatchObject({
      ok: true
    });
  });

  it("fails closed for an incompatible protocol version", async () => {
    const { pipeName } = await createServer();
    const client = await connectClient(pipeName);
    const closed = client.waitForClose();

    client.sendRaw(`${JSON.stringify({
      protocolVersion: 2,
      kind: "request",
      requestId: "wrong-version",
      method: "handshake",
      params: {
        clientId: "client-a",
        protocolVersion: 2,
        afterSequence: 0
      }
    })}\n`);

    await expect(client.nextResponse("unsupported_protocol")).resolves.toMatchObject({
      requestId: "wrong-version",
      ok: false
    });
    await expect(closed).resolves.toBeUndefined();

    const nestedVersion = await connectClient(pipeName);
    const nestedClosed = nestedVersion.waitForClose();
    await expect(nestedVersion.requestWithId(
      "wrong-handshake-version",
      "handshake",
      {
        clientId: "client-a",
        protocolVersion: 2,
        afterSequence: 0
      }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported_protocol" }
    });
    await expect(nestedClosed).resolves.toBeUndefined();
  });

  it.each(["envelope", "handshake"] as const)(
    "aborts buffered work after an unsupported %s version",
    async (versionLocation) => {
      const store = createStore();
      let pauses = 0;
      const leases = createLeases(store, () => {
        pauses += 1;
      });
      const orchestrator = new RecordingOrchestrator();
      const { pipeName } = await createServer({ store, leases, orchestrator });
      const client = await connectClient(pipeName);
      const unsupportedVersion = "2".repeat(128 * 1024);
      const unsupported = {
        protocolVersion:
          versionLocation === "envelope" ? unsupportedVersion : 1,
        kind: "request",
        requestId: `unsupported-${versionLocation}`,
        method: "handshake",
        params: {
          clientId: "client-buffered",
          protocolVersion:
            versionLocation === "handshake" ? unsupportedVersion : 1,
          afterSequence: 0
        }
      };
      const handshake = {
        protocolVersion: 1,
        kind: "request",
        requestId: "buffered-handshake",
        method: "handshake",
        params: {
          clientId: "client-buffered",
          protocolVersion: 1,
          afterSequence: 0
        }
      };
      const start = {
        protocolVersion: 1,
        kind: "request",
        requestId: "buffered-start",
        method: "company.start",
        params: { scenarios: {} }
      };
      const closed = client.waitForClose();

      client.sendBatch([
        `${JSON.stringify(unsupported)}\n`,
        `${JSON.stringify(handshake)}\n`,
        `${JSON.stringify(start)}\n`
      ]);

      await expect(closed).resolves.toBeUndefined();
      expect(orchestrator.starts).toHaveLength(0);
      expect(pauses).toBe(0);
    }
  );

  it("rejects invalid JSON, unknown methods, and request ID conflicts", async () => {
    const { pipeName } = await createServer();
    const client = await connectClient(pipeName);

    client.sendRaw("not-json\n");
    await expect(client.nextResponse("invalid_json")).resolves.toMatchObject({
      ok: false
    });

    await client.handshake();
    await expect(client.request("unknown.method", {})).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_method" }
    });

    const first = await client.requestWithId("conflict-id", "company.status", {
      alpha: 1,
      beta: 2
    });
    const stableDuplicate = await client.requestWithId(
      "conflict-id",
      "company.status",
      { beta: 2, alpha: 1 }
    );
    expect(stableDuplicate).toEqual(first);
    await expect(client.requestWithId(
      "conflict-id",
      "events.list",
      { afterSequence: 0 }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "request_id_conflict" }
    });
  });

  it("coalesces concurrent retries of the same request ID", async () => {
    const orchestrator = new SharedGateOrchestrator();
    const { pipeName } = await createServer({ orchestrator });
    const firstClient = await connectClient(pipeName);
    const secondClient = await connectClient(pipeName);
    await firstClient.handshake("client-concurrent-a");
    await secondClient.handshake("client-concurrent-b");

    const first = firstClient.requestWithId(
      "concurrent-id",
      "company.start",
      { scenarios: { leader: "idle" } }
    );
    await orchestrator.started;
    const second = secondClient.requestWithId(
      "concurrent-id",
      "company.start",
      { scenarios: { leader: "idle" } }
    );
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));

    const startCount = orchestrator.starts.length;
    orchestrator.release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(startCount).toBe(1);
    expect(secondResponse).toEqual(firstResponse);
  });

  it("routes the request surface and validates dispatched actions", async () => {
    const store = createStore();
    store.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: {
        id: randomUUID(),
        type: "company.created",
        actorId: "owner",
        taskId: null,
        causationEventId: null,
        payload: {}
      }
    });
    const orchestrator = new RecordingOrchestrator();
    const { pipeName } = await createServer({ store, orchestrator });
    const client = await connectClient(pipeName);
    await client.handshake("client-routing", 1);

    await expect(client.request("client.heartbeat", {
      clientId: "client-routing"
    })).resolves.toMatchObject({
      ok: true,
      result: { renewed: true }
    });
    await expect(client.request("client.heartbeat", {
      clientId: "another-client"
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_params" }
    });
    await expect(client.request("company.status", {
      companyId: "company-1"
    })).resolves.toMatchObject({
      ok: true,
      result: { id: "company-1", status: "active" }
    });
    await expect(client.request("tasks.list", {
      companyId: "company-1"
    })).resolves.toMatchObject({ ok: true, result: [] });
    await expect(client.request("events.list", {
      afterSequence: 0
    })).resolves.toMatchObject({
      ok: true,
      result: [expect.objectContaining({ type: "company.created" })]
    });

    await expect(client.request("company.start", {
      scenarios: { leader: "idle" }
    })).resolves.toMatchObject({ ok: true });
    await expect(client.request("company.resume", {
      scenarios: { leader: "resume" }
    })).resolves.toMatchObject({ ok: true });
    await expect(client.request("company.pause", {})).resolves.toMatchObject({
      ok: true
    });
    await expect(client.request("company.stop", {})).resolves.toMatchObject({
      ok: true
    });
    expect(orchestrator.starts).toEqual([
      { leader: "idle" },
      { leader: "resume" }
    ]);
    expect(orchestrator.stopDispatchingCalls).toBe(2);

    await expect(client.request("action.dispatch", {
      action: { type: "task.propose" }
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_action" }
    });
    expect(orchestrator.actions).toHaveLength(0);

    const action: ActionProposal = {
      schemaVersion: 1,
      actionId: randomUUID(),
      type: "company.complete.request",
      actorEmployeeId: "leader",
      taskId: null,
      payload: {},
      reason: "work complete",
      causationEventId: null
    };
    await expect(client.request("action.dispatch", {
      action
    })).resolves.toMatchObject({ ok: true });
    expect(orchestrator.actions).toEqual([action]);
  });

  it("clears phantom leases at listen and disconnects the live client", async () => {
    const store = createStore();
    store.upsertLease("phantom-client", 99_999);
    let pauses = 0;
    const leases = createLeases(store, () => {
      pauses += 1;
    });
    const { pipeName } = await createServer({ store, leases });
    expect(store.countLeases()).toBe(0);

    const client = await connectClient(pipeName);
    await client.handshake("client-lease");
    expect(store.countLeases()).toBe(1);

    await client.close();
    await waitUntil(
      () => store.countLeases() === 0,
      "server did not disconnect the client lease"
    );
    expect(store.countLeases()).toBe(0);
    expect(pauses).toBe(1);
  });

  it("keeps a shared client lease until its last socket disconnects", async () => {
    const store = createStore();
    let pauses = 0;
    const leases = createLeases(store, () => {
      pauses += 1;
    });
    const { pipeName } = await createServer({ store, leases });
    const first = await connectClient(pipeName);
    const second = await connectClient(pipeName);
    await first.handshake("shared-client");
    await second.handshake("shared-client");

    await first.close();
    expect(store.countLeases()).toBe(1);
    expect(pauses).toBe(0);
    await expect(second.request("client.heartbeat", {})).resolves.toMatchObject({
      ok: true
    });

    await second.close();
    await waitUntil(
      () => store.countLeases() === 0,
      "server did not release the final shared-client lease"
    );
    expect(pauses).toBe(1);
  });

  it("renews each client lease when a heartbeat response is replayed", async () => {
    const store = createStore();
    let now = 1_000;
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => undefined
    });
    const { pipeName } = await createServer({ store, leases });
    const first = await connectClient(pipeName);
    const second = await connectClient(pipeName);
    await first.handshake("heartbeat-a");
    await second.handshake("heartbeat-b");

    now = 4_000;
    await first.requestWithId("shared-heartbeat", "client.heartbeat", {});
    now = 5_000;
    await second.requestWithId("shared-heartbeat", "client.heartbeat", {});
    now = 7_000;
    await leases.sweep();

    expect(store.countLeases()).toBe(2);
  });

  it("rejects unsafe pipe names before binding and closes live sockets", async () => {
    const store = createStore();
    const unsafe = new CoreServer({
      pipeName: "../outside",
      store,
      orchestrator: new RecordingOrchestrator(),
      leases: createLeases(store)
    });
    await expect(unsafe.listen()).rejects.toThrow("safe AgentTown name");

    const { pipeName, server } = await createServer();
    const client = await connectClient(pipeName);
    await client.handshake("client-close");
    const closed = client.waitForClose();

    await server.close();

    await expect(closed).resolves.toBeUndefined();
    await expect(TestClient.connect(pipeName)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("closes gracefully after an in-flight response is written", async () => {
    const orchestrator = new BlockingOrchestrator();
    const { pipeName, server } = await createServer({ orchestrator });
    const client = await connectClient(pipeName);
    await client.handshake("client-graceful-close");
    const response = client.request("company.start", { scenarios: {} });
    await orchestrator.started;
    const closed = client.waitForClose();
    const closing = server.closeAfterResponses();

    orchestrator.release();

    await expect(response).resolves.toMatchObject({ ok: true });
    await expect(closing).resolves.toBeUndefined();
    await expect(closed).resolves.toBeUndefined();
  });

  it("atomically stops accepting work before graceful draining", async () => {
    const orchestrator = new BlockingOrchestrator();
    const { pipeName, server } = await createServer({ orchestrator });
    const client = await connectClient(pipeName);
    await client.handshake("client-atomic-close");
    const first = client.request("company.start", {
      scenarios: { first: "scenario" }
    });
    await orchestrator.started;

    const closing = server.closeAfterResponses();
    client.sendRaw(`${JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      requestId: "after-drain-started",
      method: "company.start",
      params: { scenarios: { second: "scenario" } }
    })}\n`);
    orchestrator.release();

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(closing).resolves.toBeUndefined();
    expect(orchestrator.starts).toEqual([{ first: "scenario" }]);
  });

  it("closes a client whose queued inbound work exceeds its byte budget", async () => {
    const orchestrator = new BlockingOrchestrator();
    const { pipeName } = await createServer({
      orchestrator,
      serverOptions: { maxInboundQueuedBytes: 512 }
    });
    const client = await connectClient(pipeName);
    await client.handshake("client-inbound-budget");
    client.sendRaw(`${JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      requestId: "blocking-start",
      method: "company.start",
      params: { scenarios: { first: "scenario" } }
    })}\n`);
    await orchestrator.started;
    const closed = client.waitForClose();
    const padding = "x".repeat(300);
    client.sendBatch([1, 2, 3].map((index) => `${JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      requestId: `queued-${index}`,
      method: "company.start",
      params: { scenarios: { padding } }
    })}\n`));

    await expect(closed).resolves.toBeUndefined();
    expect(orchestrator.starts).toHaveLength(1);
    orchestrator.release();
  });

  it("closes a client when one outbound message exceeds its byte budget", async () => {
    const { pipeName, store } = await createServer({
      serverOptions: { maxOutboundQueuedBytes: 512 }
    });
    const client = await connectClient(pipeName);
    await client.handshake("client-outbound-budget");
    const closed = client.waitForClose();

    store.insertEvent({
      id: randomUUID(),
      type: "large-event",
      actorId: "test",
      taskId: null,
      causationEventId: null,
      payload: { padding: "x".repeat(1_024) }
    });

    await expect(closed).resolves.toBeUndefined();
  });

  it("rejects a request line above the configured limit", async () => {
    const orchestrator = new RecordingOrchestrator();
    const { pipeName } = await createServer({
      orchestrator,
      serverOptions: { maxRequestLineBytes: 256 }
    });
    const client = await connectClient(pipeName);
    await client.handshake("client-request-limit");
    client.sendRaw(`${JSON.stringify({
      protocolVersion: 1,
      kind: "request",
      requestId: "oversized-request",
      method: "company.start",
      params: { scenarios: { padding: "x".repeat(300) } }
    })}\n`);

    await expect(client.nextResponse("message_too_large")).resolves.toMatchObject({
      ok: false
    });
    await expect(client.waitForClose()).resolves.toBeUndefined();
    expect(orchestrator.starts).toHaveLength(0);
  });

  it("does not retain completed responses above the cache byte budget", async () => {
    const orchestrator = new RecordingOrchestrator();
    const { pipeName } = await createServer({
      orchestrator,
      serverOptions: { requestCacheByteLimit: 1 }
    });
    const client = await connectClient(pipeName);
    await client.handshake("client-cache-budget");

    await client.requestWithId("evicted-start", "company.start", {
      scenarios: { first: "scenario" }
    });
    await client.requestWithId("evicted-start", "company.start", {
      scenarios: { first: "scenario" }
    });

    expect(orchestrator.starts).toHaveLength(2);
  });

  it("awaits final lease cleanup before server close resolves", async () => {
    const store = createStore();
    let resolveStarted: () => void = () => undefined;
    const callbackStarted = new Promise<void>((resolvePromise) => {
      resolveStarted = resolvePromise;
    });
    let release: () => void = () => undefined;
    const callbackGate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const leases = createLeases(store, async () => {
      resolveStarted();
      await callbackGate;
    });
    const { pipeName, server } = await createServer({ store, leases });
    const client = await connectClient(pipeName);
    await client.handshake("client-awaited-cleanup");
    await client.close();
    await callbackStarted;

    let closeSettled = false;
    const closing = server.close().then(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    expect(closeSettled).toBe(false);
    release();
    await closing;
  });

  it("captures and reports periodic lease sweep failures", async () => {
    const store = createStore();
    let now = 0;
    const leases = new LeaseRegistry(store, {
      ttlMs: 5_000,
      now: () => now,
      onLastClientExpired: () => {
        throw new Error("periodic pause failed");
      }
    });
    const reported: Error[] = [];
    const { pipeName, server } = await createServer({
      store,
      leases,
      serverOptions: {
        leaseSweepIntervalMs: 10,
        onBackgroundError: (error) => reported.push(error)
      }
    });
    const client = await connectClient(pipeName);
    await client.handshake("client-periodic-error");
    now = 10_000;

    await waitUntil(
      () => server.backgroundErrors.length > 0 && reported.length > 0,
      "server did not report the periodic lease failure"
    );
    expect(server.backgroundErrors[0]?.message).toBe("periodic pause failed");
    expect(reported[0]?.message).toBe("periodic pause failed");
  });
});
