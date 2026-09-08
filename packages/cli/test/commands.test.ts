import { describe, expect, it, vi } from "vitest";
import type { CliClient, CliRuntime } from "../src/main.js";
import { dispatchInput, submitWizardDraft } from "../src/tui/commands.js";
import type { EmployeeDefinition } from "@agenttown/runtime-contract";

function employee(id: string, workspace: EmployeeDefinition["workspace"]): EmployeeDefinition {
  return { id, role: "developer", agent: "fake", reportsTo: "leader", workspace };
}

const EMPLOYEES = [
  employee("leader", "read_only"),
  employee("developer-a", "git_worktree"),
  employee("developer-b", "git_worktree")
];

function ctx(overrides: Partial<Parameters<typeof dispatchInput>[1]> = {}) {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const client: CliClient = {
    async request(method, params) {
      calls.push({ method, params });
      return { ok: true };
    },
    events() {
      return (async function* () {})();
    },
    async close() {}
  };
  const connectOrStart = async () => client;
  return {
    ctx: {
      projectRoot: "D:\\project",
      connectOrStart,
      employees: EMPLOYEES,
      leaderId: "leader",
      ...overrides
    },
    calls
  };
}

describe("dispatchInput", () => {
  it("executes commands through runCli with captured output", async () => {
    const { ctx: context } = ctx();
    const outcome = await dispatchInput("status", context);
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      // runCli will fail (not initialized) — the error text becomes the result
      expect(outcome.text.length).toBeGreaterThan(0);
    }
  });

  it("blocks high-risk commands with a hint", async () => {
    const { ctx: context } = ctx();
    const outcome = await dispatchInput("stop", context);
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain("退出 TUI");
    }
  });

  it("flags failed command results as errors", async () => {
    const { ctx: context } = ctx();
    const outcome = await dispatchInput("status", context);
    expect(outcome.kind).toBe("result");
    if (outcome.kind === "result") {
      // not-initialized error surfaces from runCli → ok must be false
      expect(outcome.ok).toBe(false);
      expect(outcome.text.length).toBeGreaterThan(0);
    }
  });

  it("starts a wizard for task creation", async () => {
    const { ctx: context } = ctx();
    const outcome = await dispatchInput("让 developer-a 做登录页面", context);
    expect(outcome.kind).toBe("wizard");
    if (outcome.kind === "wizard") {
      expect(outcome.view.candidates).toEqual(["developer-a", "developer-b"]);
      expect(outcome.view.preview.assignee).toBe("developer-a");
      expect(outcome.view.preview.title).toBe("登录页面");
    }
  });

  it("defaults the assignee to the first developer when none is named", async () => {
    const { ctx: context } = ctx();
    const outcome = await dispatchInput("帮我写一个笑话文档", context);
    expect(outcome.kind).toBe("wizard");
    if (outcome.kind === "wizard") {
      // no employee named → first git_worktree developer is pre-selected so
      // the task does not sit in draft with no one to run it
      expect(outcome.view.preview.assignee).toBe("developer-a");
      expect(outcome.view.preview.title).toBe("一个笑话文档");
      expect(outcome.view.preview.objective).toBe("写一个笑话文档");
    }
  });

  it("maps view intents", async () => {
    const { ctx: context } = ctx();
    expect(await dispatchInput("看下任务", context)).toEqual({ kind: "view", view: "tasks" });
  });

  it("returns unknown for unrecognized input", async () => {
    const { ctx: context } = ctx();
    expect(await dispatchInput("hello", context)).toEqual({ kind: "unknown" });
  });
});

describe("submitWizardDraft", () => {
  it("dispatches propose and assign through action.dispatch", async () => {
    const { ctx: context, calls } = ctx();
    const text = await submitWizardDraft({
      title: "登录页面",
      objective: "用户可以登录",
      assignee: "developer-a",
      acceptanceCriteria: ["表单校验"]
    }, context);
    expect(text).toContain("任务已创建");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("action.dispatch");
    expect(calls[0]!.params.action.type).toBe("task.propose");
    expect(calls[0]!.params.action.actorEmployeeId).toBe("leader");
    expect(calls[0]!.params.action.payload.title).toBe("登录页面");
    expect(calls[0]!.params.action.payload.acceptanceCriteria).toEqual(["表单校验"]);
    expect(calls[1]!.params.action.type).toBe("task.assign");
    expect(calls[1]!.params.action.payload.assignee).toBe("developer-a");
  });

  it("omits assign when no assignee", async () => {
    const { ctx: context, calls } = ctx();
    await submitWizardDraft({
      title: "任务",
      objective: "目标",
      assignee: null,
      acceptanceCriteria: []
    }, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.action.payload.acceptanceCriteria).toEqual(["目标"]);
  });
});
