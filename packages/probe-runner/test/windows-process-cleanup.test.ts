import { describe, expect, it, vi } from "vitest";
import {
  cleanupVerifiedProcessTree,
  type WindowsProcessIdentity
} from "./windows-process-cleanup.js";

function identity(pid: number, nonce: string): WindowsProcessIdentity {
  return {
    ProcessId: pid,
    CreationDate: "20260720231500.000000+480",
    Name: "node.exe",
    CommandLine: `node.exe -e worker ${nonce}`
  };
}

describe("cleanupVerifiedProcessTree", () => {
  it("re-queries the grandchild only after the parent tree kill", async () => {
    const nonce = "agenttown-unique-cleanup-nonce";
    const calls: string[] = [];
    const queryIdentity = vi.fn(async (pid: number) => {
      calls.push(`query:${pid}`);
      return pid === 10 ? identity(pid, nonce) : undefined;
    });
    const killTree = vi.fn(async (pid: number) => {
      calls.push(`kill:${pid}`);
    });

    await cleanupVerifiedProcessTree({ parentPid: 10, grandchildPid: 20, nonce }, {
      queryIdentity,
      killTree
    });

    expect(calls).toEqual(["query:10", "kill:10", "query:20"]);
    expect(killTree).toHaveBeenCalledTimes(1);
  });

  it("refuses to kill a PID whose just-in-time identity does not match", async () => {
    const killTree = vi.fn(async () => undefined);

    await expect(cleanupVerifiedProcessTree({
      parentPid: 10,
      grandchildPid: 20,
      nonce: "expected-nonce"
    }, {
      queryIdentity: async () => identity(10, "different-nonce"),
      killTree
    })).rejects.toThrow(/identity changed/iu);

    expect(killTree).not.toHaveBeenCalled();
  });
});
