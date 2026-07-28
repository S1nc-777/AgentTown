import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentTownClient } from "../src/client.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
});

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

describe("AgentTownClient", () => {
  it("handshakes, requests, receives events, heartbeats and clears the lease on close", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const methods: string[] = [];
    let socketClosed = false;
    const server = createServer((socket: Socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("close", () => {
        socketClosed = true;
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline)) as {
            requestId: string;
            method: string;
          };
          buffer = buffer.slice(newline + 1);
          methods.push(request.method);
          const result = request.method === "handshake"
            ? { leaseTtlMs: 30 }
            : { echoed: request.method };
          socket.write(`${JSON.stringify({
            protocolVersion: 1,
            kind: "response",
            requestId: request.requestId,
            ok: true,
            result,
            error: null
          })}\n`);
          if (request.method === "handshake") {
            socket.write(`${JSON.stringify({
              protocolVersion: 1,
              kind: "event",
              sequence: 1,
              type: "company.created",
              payload: {}
            })}\n`);
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(`\\\\.\\pipe\\${pipeName}`, () => resolvePromise());
    });

    const client = await AgentTownClient.connect(pipeName, "test-client", 0);
    await expect(client.request("company.status", {}))
      .resolves.toEqual({ echoed: "company.status" });
    const event = await client.events()[Symbol.asyncIterator]().next();
    expect(event).toMatchObject({
      done: false,
      value: { sequence: 1, type: "company.created" }
    });
    await waitUntil(
      () => methods.includes("client.heartbeat"),
      "heartbeat was not sent"
    );
    await client.close();
    await waitUntil(() => socketClosed, "socket did not close");
  });

  it("fails closed on an oversized unterminated line", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { requestId: string };
        socket.write(`${JSON.stringify({
          protocolVersion: 1,
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { leaseTtlMs: 3_000 },
          error: null
        })}\n`);
        setImmediate(() => socket.write("x".repeat(1024 * 1024 + 1)));
      });
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => {
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise);
    });
    const client = await AgentTownClient.connect(pipeName, "oversize", 0);

    await expect(client.events()[Symbol.asyncIterator]().next())
      .rejects.toThrow("line exceeds");
    await client.close();
  });

  it("keeps at most one heartbeat in flight against a stalled Core", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    let heartbeatCount = 0;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const newline = buffer.indexOf("\n");
          const request = JSON.parse(buffer.slice(0, newline)) as {
            requestId: string;
            method: string;
          };
          buffer = buffer.slice(newline + 1);
          if (request.method === "client.heartbeat") {
            heartbeatCount += 1;
            continue;
          }
          socket.write(`${JSON.stringify({
            protocolVersion: 1,
            kind: "response",
            requestId: request.requestId,
            ok: true,
            result: { leaseTtlMs: 30 },
            error: null
          })}\n`);
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => {
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise);
    });
    const client = await AgentTownClient.connect(pipeName, "stalled", 0);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));

    expect(heartbeatCount).toBe(1);
    await client.close();
  });

  it("pauses input and delivers a high-volume event stream without drops", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const eventCount = 600;
    const server = createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { requestId: string };
        const lines = [
          JSON.stringify({
            protocolVersion: 1,
            kind: "response",
            requestId: request.requestId,
            ok: true,
            result: { leaseTtlMs: 30_000 },
            error: null
          }),
          ...Array.from({ length: eventCount }, (_, index) => JSON.stringify({
            protocolVersion: 1,
            kind: "event",
            sequence: index + 1,
            type: "task.progress",
            payload: { index }
          }))
        ];
        socket.write(`${lines.join("\n")}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => {
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise);
    });
    const client = await AgentTownClient.connect(pipeName, "event-volume", 0);
    const received: number[] = [];
    for await (const event of client.events()) {
      received.push(event.sequence);
      if (received.length === eventCount) break;
    }

    expect(received).toEqual(
      Array.from({ length: eventCount }, (_, index) => index + 1)
    );
    await client.close();
  });

  it("bounds stalled requests and closes a half-open socket", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    let acceptedSocket: Socket | undefined;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      acceptedSocket = socket;
      socket.setEncoding("utf8");
      socket.once("data", (chunk: string) => {
        const request = JSON.parse(chunk.trim()) as { requestId: string };
        socket.write(`${JSON.stringify({
          protocolVersion: 1,
          kind: "response",
          requestId: request.requestId,
          ok: true,
          result: { leaseTtlMs: 30_000 },
          error: null
        })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => {
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise);
    });
    const client = await AgentTownClient.connect(pipeName, "bounded", 0);
    const largeRequests = Array.from({ length: 6 }, (_, index) =>
      client.request("large-stalled", {
        index,
        payload: "x".repeat(800 * 1024)
      })
    );
    const largeResults = await Promise.all(
      largeRequests.map(async (request) => {
        try {
          await request;
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }).slice(5)
    );
    expect(largeResults.some((message) =>
      message.includes("queued Core request bytes")
    )).toBe(true);
    let boundedRejections = 0;
    const requests = Array.from({ length: 300 }, (_, index) =>
      client.request("stalled", { index }).catch((error: unknown) => {
        if (
          error instanceof Error
          && error.message.includes("too many pending")
        ) {
          boundedRejections += 1;
        }
        throw error;
      })
    );
    const settled = Promise.allSettled(requests);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
    expect(boundedRejections).toBeGreaterThan(0);
    const startedAt = Date.now();
    await client.close();
    await Promise.allSettled(largeRequests);
    await settled;
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    acceptedSocket?.destroy();
  });

  it("bounds connect plus handshake and destroys the stalled socket", async () => {
    const pipeName = `agenttown-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    let socketClosed = false;
    const server = createServer((socket) => {
      socket.on("close", () => {
        socketClosed = true;
      });
      socket.resume();
    });
    servers.push(server);
    await new Promise<void>((resolvePromise) => {
      server.listen(`\\\\.\\pipe\\${pipeName}`, resolvePromise);
    });
    const startedAt = Date.now();

    await expect(AgentTownClient.connect(pipeName, "timeout", 0, 50))
      .rejects.toThrow("timed out");

    expect(Date.now() - startedAt).toBeLessThan(500);
    await waitUntil(() => socketClosed, "timed-out socket was not destroyed");
  });
});
