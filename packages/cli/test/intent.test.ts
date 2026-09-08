import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/tui/intent.js";

const EMPLOYEES = ["leader", "developer-a", "developer-b", "reviewer"];

describe("parseIntent", () => {
  it("recognizes slash commands", () => {
    expect(parseIntent("/pause", EMPLOYEES)).toEqual({ kind: "command", command: "pause", args: [] });
    expect(parseIntent("/tasks", EMPLOYEES)).toEqual({ kind: "command", command: "tasks", args: [] });
    expect(parseIntent("/approve abc", EMPLOYEES)).toEqual({ kind: "command", command: "approve", args: ["abc"] });
  });

  it("recognizes bare commands", () => {
    expect(parseIntent("pause", EMPLOYEES)).toEqual({ kind: "command", command: "pause", args: [] });
    expect(parseIntent("resume", EMPLOYEES)).toEqual({ kind: "command", command: "resume", args: [] });
    expect(parseIntent("timeline", EMPLOYEES)).toEqual({ kind: "command", command: "timeline", args: [] });
  });

  it("maps Chinese control phrases", () => {
    expect(parseIntent("暂停", EMPLOYEES)).toEqual({ kind: "command", command: "pause", args: [] });
    expect(parseIntent("帮我暂停一下公司", EMPLOYEES)).toEqual({ kind: "command", command: "pause", args: [] });
    expect(parseIntent("恢复", EMPLOYEES)).toEqual({ kind: "command", command: "resume", args: [] });
    expect(parseIntent("继续", EMPLOYEES)).toEqual({ kind: "command", command: "resume", args: [] });
    expect(parseIntent("启动公司", EMPLOYEES)).toEqual({ kind: "command", command: "start", args: [] });
  });

  it("recognizes help markers including full-width question marks", () => {
    expect(parseIntent("?", EMPLOYEES)).toEqual({ kind: "help" });
    expect(parseIntent("？", EMPLOYEES)).toEqual({ kind: "help" });
    expect(parseIntent("怎么用", EMPLOYEES)).toEqual({ kind: "help" });
    expect(parseIntent("帮助", EMPLOYEES)).toEqual({ kind: "help" });
  });

  it("recognizes task creation with an employee", () => {
    expect(parseIntent("让 developer-a 做登录页面", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "developer-a", title: "登录页面", objective: null
    });
    expect(parseIntent("叫 leader 实现注册功能", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "leader", title: "注册功能", objective: null
    });
    expect(parseIntent("developer-b 完成支付模块", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "developer-b", title: "支付模块", objective: null
    });
  });

  it("does not treat a task title containing control words as a command", () => {
    // "实现暂停功能" 是任务创建，不是暂停命令
    expect(parseIntent("实现暂停功能", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "暂停功能", objective: "实现暂停功能"
    });
  });

  it("recognizes generic task creation without an employee", () => {
    expect(parseIntent("实现登录页面", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "登录页面", objective: "实现登录页面"
    });
    expect(parseIntent("做一个计算器", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "一个计算器", objective: "做一个计算器"
    });
  });

  it("accepts polite free-form task requests with pre-filled objective", () => {
    const request = "帮我写一个md文档在这个目录下，文档中包含一个你自己想的笑话";
    const intent = parseIntent(request, EMPLOYEES);
    expect(intent.kind).toBe("task-create");
    if (intent.kind === "task-create") {
      expect(intent.assignee).toBeNull();
      expect(intent.title).toBe("一个md文档在这个目录下，文档中包含一个你自己想的笑话");
      expect(intent.objective).toBe("写一个md文档在这个目录下，文档中包含一个你自己想的笑话");
    }
  });

  it("treats polite openers with control words as commands", () => {
    expect(parseIntent("帮我暂停一下公司", EMPLOYEES)).toEqual({ kind: "command", command: "pause", args: [] });
    expect(parseIntent("帮我启动公司", EMPLOYEES)).toEqual({ kind: "command", command: "start", args: [] });
  });

  it("truncates very long free-form titles but keeps the full objective", () => {
    const longRequest = "帮我实现一个超长任务标题用来验证截断逻辑是否正常工作在四十个字符以上时会自动截断并保留完整目标文本";
    const intent = parseIntent(longRequest, EMPLOYEES);
    expect(intent.kind).toBe("task-create");
    if (intent.kind === "task-create") {
      expect(intent.title).toContain("…");
      expect(intent.objective).toContain("实现一个超长任务标题");
      expect(intent.objective).not.toContain("帮我");
    }
  });

  it("maps questions to answer topics instead of views", () => {
    expect(parseIntent("现在有哪些员工", EMPLOYEES)).toEqual({ kind: "question", topic: "employees" });
    expect(parseIntent("员工分别叫什么", EMPLOYEES)).toEqual({ kind: "question", topic: "employees" });
    expect(parseIntent("谁在干活", EMPLOYEES)).toEqual({ kind: "question", topic: "employees" });
    expect(parseIntent("有哪些任务", EMPLOYEES)).toEqual({ kind: "question", topic: "tasks" });
    expect(parseIntent("任务进度怎么样", EMPLOYEES)).toEqual({ kind: "question", topic: "tasks" });
    expect(parseIntent("公司现在怎么样", EMPLOYEES)).toEqual({ kind: "question", topic: "status" });
  });

  it("switches views only on clear imperatives", () => {
    expect(parseIntent("看下任务", EMPLOYEES)).toEqual({ kind: "view", view: "tasks" });
    expect(parseIntent("任务列表", EMPLOYEES)).toEqual({ kind: "view", view: "tasks" });
    expect(parseIntent("切到员工视图", EMPLOYEES)).toEqual({ kind: "view", view: "employees" });
    expect(parseIntent("看下事件", EMPLOYEES)).toEqual({ kind: "view", view: "events" });
    expect(parseIntent("看下待审批", EMPLOYEES)).toEqual({ kind: "view", view: "approvals" });
    expect(parseIntent("有哪些待审批", EMPLOYEES)).toEqual({ kind: "view", view: "approvals" });
  });

  it("returns unknown for unrecognized input", () => {
    expect(parseIntent("hello world", EMPLOYEES)).toEqual({ kind: "unknown" });
    expect(parseIntent("", EMPLOYEES)).toEqual({ kind: "unknown" });
    expect(parseIntent("   ", EMPLOYEES)).toEqual({ kind: "unknown" });
  });
});
