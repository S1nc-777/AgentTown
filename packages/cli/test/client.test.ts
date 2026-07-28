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
});
