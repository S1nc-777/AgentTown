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

  it("maps view phrases", () => {
    expect(parseIntent("看下任务", EMPLOYEES)).toEqual({ kind: "view", view: "tasks" });
    expect(parseIntent("任务列表", EMPLOYEES)).toEqual({ kind: "view", view: "tasks" });
    expect(parseIntent("有哪些待审批", EMPLOYEES)).toEqual({ kind: "view", view: "approvals" });
    expect(parseIntent("员工在干嘛", EMPLOYEES)).toEqual({ kind: "view", view: "employees" });
    expect(parseIntent("看下事件", EMPLOYEES)).toEqual({ kind: "view", view: "events" });
  });

  it("recognizes help", () => {
    expect(parseIntent("?", EMPLOYEES)).toEqual({ kind: "help" });
    expect(parseIntent("帮助", EMPLOYEES)).toEqual({ kind: "help" });
  });

  it("recognizes task creation with an employee", () => {
    expect(parseIntent("让 developer-a 做登录页面", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "developer-a", title: "登录页面"
    });
    expect(parseIntent("叫 leader 实现注册功能", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "leader", title: "注册功能"
    });
    expect(parseIntent("developer-b 完成支付模块", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: "developer-b", title: "支付模块"
    });
  });

  it("does not treat a task title containing control words as a command", () => {
    // "实现暂停功能" 是任务创建，不是暂停命令
    expect(parseIntent("实现暂停功能", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "暂停功能"
    });
  });

  it("recognizes generic task creation without an employee", () => {
    expect(parseIntent("实现登录页面", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "登录页面"
    });
    expect(parseIntent("做一个计算器", EMPLOYEES)).toEqual({
      kind: "task-create", assignee: null, title: "一个计算器"
    });
  });

  it("returns unknown for unrecognized input", () => {
    expect(parseIntent("hello world", EMPLOYEES)).toEqual({ kind: "unknown" });
    expect(parseIntent("", EMPLOYEES)).toEqual({ kind: "unknown" });
    expect(parseIntent("   ", EMPLOYEES)).toEqual({ kind: "unknown" });
  });
});
