import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { connectCore, openPipe, type ConnectCoreOptions, type ConnectFunction } from "../src/core-client.js";

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: string[] = [];
  onWrite?: (text: string) => void;

  setEncoding() {
    return this;
  }

  write(text: string) {
    this.writes.push(text);
    this.onWrite?.(text);
    return true;
  }

  destroy() {
    this.destroyed = true;
    return this;
  }

  asSocket() {
    return this as unknown as Socket;
  }
}

function codedError(code: string) {
  return Object.assign(new Error(code), { code });
}

function connector(...steps: Array<{ socket: FakeSocket; event?: "connect"; error?: Error }>): {
  connect: ConnectFunction;
  calls(): number;
} {
  let calls = 0;
  return {
    connect: () => {
      const step = steps[calls++];
      if (!step) throw new Error("unexpected connection attempt");
      queueMicrotask(() => {
        if (step.error) step.socket.emit("error", step.error);
        else if (step.event === "connect") step.socket.emit("connect");
      });
      return step.socket.asSocket();
    },
    calls: () => calls
  };
}

function healthySocket(): FakeSocket {
  const socket = new FakeSocket();
  socket.onWrite = () =>
    queueMicrotask(() => socket.emit("data", '{"type":"health","status":"ok"}\n'));
  return socket;
}

function options(
  connect: ConnectFunction,
  launchCore: () => void | Promise<void> = () => undefined
): ConnectCoreOptions {
  return {
    pipeName: "agenttown-probe-offline-test",
    connect,
    launchCore,
    openTimeoutMs: 20,
    healthTimeoutMs: 20,
    startupDeadlineMs: 100,
    retryDelayMs: 1
  };
}

describe("openPipe", () => {
  it("bounds a socket that never emits connect or error and removes its listeners", async () => {
    const socket = new FakeSocket();
    await expect(
      openPipe("\\\\.\\pipe\\agenttown-probe-never", {
        connect: () => socket.asSocket(),
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ code: "PIPE_CONNECT_TIMEOUT" });
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("connect")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });
});

describe("connectCore", () => {
  it("rejects an accepted pipe that never answers health without launching", async () => {
    const socket = new FakeSocket();
    const connection = connector({ socket, event: "connect" });
    let launches = 0;
    await expect(connectCore(options(connection.connect, () => { launches++; }))).rejects.toThrow(
      "core health response timed out"
    );
    expect(launches).toBe(0);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects malformed and unhealthy health responses", async () => {
    const malformed = new FakeSocket();
    malformed.onWrite = () => queueMicrotask(() => malformed.emit("data", "not-json\n"));
    await expect(connectCore(options(connector({ socket: malformed, event: "connect" }).connect))).rejects.toThrow(
      "malformed core response"
    );

    const unhealthy = new FakeSocket();
    unhealthy.onWrite = () =>
      queueMicrotask(() => unhealthy.emit("data", '{"type":"health","status":"starting"}\n'));
    await expect(connectCore(options(connector({ socket: unhealthy, event: "connect" }).connect))).rejects.toThrow(
      "invalid core health response"
    );
  });

  it("does not launch for access errors", async () => {
    const socket = new FakeSocket();
    const connection = connector({ socket, error: codedError("EACCES") });
    let launches = 0;
    await expect(connectCore(options(connection.connect, () => { launches++; }))).rejects.toMatchObject({ code: "EACCES" });
    expect(launches).toBe(0);
  });

  it("launches only for a missing pipe, then retries through a healthy handshake", async () => {
    const firstMissing = new FakeSocket();
    const secondMissing = new FakeSocket();
    const healthy = healthySocket();
    const connection = connector(
      { socket: firstMissing, error: codedError("ENOENT") },
      { socket: secondMissing, error: codedError("ENOENT") },
      { socket: healthy, event: "connect" }
    );
    let launches = 0;
    const client = await connectCore(options(connection.connect, () => { launches++; }));
    expect(client).toBeDefined();
    expect(launches).toBe(1);
    expect(connection.calls()).toBe(3);
    client.close();
  });

  it("shares one launch in flight across concurrent callers", async () => {
    const missing = new FakeSocket();
    const healthy = healthySocket();
    const connection = connector(
      { socket: missing, error: codedError("ENOENT") },
      { socket: healthy, event: "connect" }
    );
    let launches = 0;
    const launchCore = async () => {
      launches++;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    const [first, second] = await Promise.all([
      connectCore(options(connection.connect, launchCore)),
      connectCore(options(connection.connect, launchCore))
    ]);
    expect(first).toBe(second);
    expect(launches).toBe(1);
    expect(connection.calls()).toBe(2);
    first.close();
  });

  it.each(["open", "health"] as const)(
    "caps a post-launch %s wait to the startup deadline",
    async (stage) => {
      const missing = new FakeSocket();
      const stalled = new FakeSocket();
      const connection = connector(
        { socket: missing, error: codedError("ENOENT") },
        stage === "health" ? { socket: stalled, event: "connect" } : { socket: stalled }
      );
      let launches = 0;
      const startedAt = Date.now();

      await expect(connectCore({
        ...options(connection.connect, () => { launches++; }),
        openTimeoutMs: 250,
        healthTimeoutMs: 250,
        startupDeadlineMs: 30
      })).rejects.toMatchObject({ code: "CORE_STARTUP_TIMEOUT" });

      expect(Date.now() - startedAt).toBeLessThan(150);
      expect(launches).toBe(1);
      expect(connection.calls()).toBe(2);
      expect(stalled.destroyed).toBe(true);
    }
  );

  it("clears a successful connection flight for a later reconnect", async () => {
    const firstMissing = new FakeSocket();
    const firstHealthy = healthySocket();
    const secondHealthy = healthySocket();
    const connection = connector(
      { socket: firstMissing, error: codedError("ENOENT") },
      { socket: firstHealthy, event: "connect" },
      { socket: secondHealthy, event: "connect" }
    );
    let launches = 0;

    const first = await connectCore(options(connection.connect, () => { launches++; }));
    first.close();
    const second = await connectCore(options(connection.connect, () => { launches++; }));

    expect(second).not.toBe(first);
    expect(launches).toBe(1);
    expect(connection.calls()).toBe(3);
    second.close();
  });

  it("clears a failed launch flight so a later caller can retry", async () => {
    const firstMissing = new FakeSocket();
    const secondMissing = new FakeSocket();
    const healthy = healthySocket();
    const connection = connector(
      { socket: firstMissing, error: codedError("ENOENT") },
      { socket: secondMissing, error: codedError("ENOENT") },
      { socket: healthy, event: "connect" }
    );
    let launches = 0;
    const launchCore = () => {
      launches++;
      if (launches === 1) throw new Error("launch failed");
    };

    await expect(connectCore(options(connection.connect, launchCore))).rejects.toThrow("launch failed");
    const client = await connectCore(options(connection.connect, launchCore));

    expect(launches).toBe(2);
    expect(connection.calls()).toBe(3);
    client.close();
  });
});
