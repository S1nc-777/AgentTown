import { describe, expect, it } from "vitest";
import { parseIpcMessage } from "../src/ipc.js";
import { parseActionProposal } from "../src/task.js";

describe("parseIpcMessage", () => {
  it("accepts a versioned request", () => {
    expect(parseIpcMessage({
      protocolVersion: 1,
      kind: "request",
      requestId: "r1",
      method: "company.status",
      params: {}
    })).toMatchObject({ kind: "request", requestId: "r1" });
  });

  it("rejects an incompatible protocol", () => {
    expect(() => parseIpcMessage({
      protocolVersion: 2,
      kind: "request",
      requestId: "r1",
      method: "company.status",
      params: {}
    })).toThrow("unsupported protocol version");
  });
});

describe("parseActionProposal", () => {
  it("rejects actions outside the closed management vocabulary", () => {
    expect(() => parseActionProposal({
      schemaVersion: 1,
      actionId: "7b346f2d-626f-4998-a678-bdd25c0013e2",
      type: "employee.create",
      actorEmployeeId: "leader",
      taskId: null,
      payload: {},
      reason: "hire another worker",
      causationEventId: null
    })).toThrow();
  });
});
