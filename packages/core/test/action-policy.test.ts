import type { ActionProposal } from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { ActionPolicy } from "../src/policy/action-policy.js";
import { companyDefinitionFixture } from "./helpers.js";

function action(overrides: Partial<ActionProposal>): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: "d81083a0-c64e-4696-b39a-9dd13af79d2c",
    type: "task.propose",
    actorEmployeeId: "leader",
    taskId: "build",
    payload: {},
    reason: "Complete the assigned work",
    causationEventId: null,
    ...overrides
  };
}

describe("ActionPolicy", () => {
  const policy = new ActionPolicy(
    companyDefinitionFixture(),
    "leader",
    new Set(["reviewer"])
  );

  it("rejects an unknown actor", () => {
    expect(() => policy.validate(action({ actorEmployeeId: "invented" })))
      .toThrow("unknown employee");
  });

  it("rejects assignment to an employee outside the fixed roster", () => {
    expect(() => policy.validate(action({
      type: "task.assign",
      payload: { assignee: "new-hire" }
    }))).toThrow("unknown assignee");
  });

  it("rejects employee creation because no such action exists", () => {
    expect(() => policy.validate({
      ...action({}),
      type: "employee.create"
    } as never)).toThrow("unsupported action");
  });

  it("lets only the reviewer approve or reject review", () => {
    expect(() => policy.validate(action({
      actorEmployeeId: "developer",
      type: "task.approve"
    }))).toThrow("review permission required");
    expect(() => policy.validate(action({
      actorEmployeeId: "developer",
      type: "task.reject"
    }))).toThrow("review permission required");
  });

  it.each(["task.propose", "task.assign", "company.complete.request"] as const)(
    "requires the leader for %s",
    (type) => {
      expect(() => policy.validate(action({
        actorEmployeeId: "developer",
        type,
        payload: type === "task.assign" ? { assignee: "developer" } : {}
      }))).toThrow("leader permission required");
    }
  );

  it("requires employee messages to name a fixed-roster recipient string", () => {
    expect(() => policy.validate(action({
      type: "employee.message",
      payload: { recipient: "new-hire" }
    }))).toThrow("unknown recipient");
    expect(() => policy.validate(action({
      type: "employee.message",
      payload: { recipient: 42 }
    }))).toThrow("unknown recipient");
  });

  it("returns a valid fixed-roster action unchanged", () => {
    const proposal = action({
      type: "task.assign",
      payload: { assignee: "developer" }
    });
    expect(policy.validate(proposal)).toBe(proposal);
  });
});
