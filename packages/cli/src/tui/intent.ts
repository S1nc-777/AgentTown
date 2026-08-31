/**
 * Commands the TUI recognizes. approve/reject/stop/cleanup are recognized
 * so the dispatcher can show its "exit the TUI" hint instead of treating
 * them as unknown input.
 */
const TUI_COMMANDS = new Set([
  "start",
  "status",
  "tasks",
  "timeline",
  "pause",
  "resume",
  "stop",
  "workspaces",
  "evidence",
  "deliver",
  "approvals",
  "approve",
  "reject",
  "cleanup",
  "help"
]);

/** Verb prefixes that introduce a task description. */
const TASK_VERB = /^(实现|做|完成|开发|写|搞定|处理|修复|加一个|新增)\s*(.+)$/u;
const ASSIGN_VERB = /^\s*(实现|做|完成|开发|写|搞定|处理|修复|新增)\s*(.+)$/u;
const ASSIGN_PREFIX = /^(让|叫|请|吩咐)\s*/u;

export type Intent =
  | { kind: "command"; command: string; args: string[] }
  | { kind: "task-create"; assignee: string | null; title: string }
  | { kind: "view"; view: "events" | "tasks" | "employees" | "approvals" }
  | { kind: "help" }
  | { kind: "unknown" };

export function parseIntent(input: string, employees: readonly string[]): Intent {
  const text = input.trim();
  if (text.length === 0) return { kind: "unknown" };

  // 1. "/command" or bare command
  const firstToken = text.startsWith("/") ? text.slice(1).trim() : text;
  const [head, ...args] = firstToken.split(/\s+/);
  if (head !== undefined && TUI_COMMANDS.has(head)) {
    return { kind: "command", command: head, args };
  }
  if (text.startsWith("/")) return { kind: "unknown" };

  // 2. "让 X 做 Y" / "叫 X 实现 Y" / "X 完成 Y" — employee name + task verb.
  //    Checked BEFORE control phrases so a title like "实现暂停功能" is not
  //    mistaken for the pause command.
  for (const employee of employees) {
    const index = text.indexOf(employee);
    if (index < 0) continue;
    const before = text.slice(0, index);
    const after = text.slice(index + employee.length);
    if (ASSIGN_PREFIX.test(before)) {
      const match = ASSIGN_VERB.exec(after);
      if (match !== null && match[2] !== undefined && match[2].length > 0) {
        return { kind: "task-create", assignee: employee, title: match[2].trim() };
      }
    } else {
      const match = ASSIGN_VERB.exec(after);
      if (match !== null && match[2] !== undefined && match[2].length > 0 && before.trim().length === 0) {
        return { kind: "task-create", assignee: employee, title: match[2].trim() };
      }
    }
  }

  // 3. Generic task creation: "实现登录页面" / "做一个计算器"
  const generic = TASK_VERB.exec(text);
  if (generic !== null && generic[2] !== undefined && generic[2].length > 0) {
    return { kind: "task-create", assignee: null, title: generic[2].trim() };
  }

  // 4. Chinese control phrases (checked after task creation so task titles
  //    containing these words are not hijacked).
  const control = /^(请|帮我)?\s*(暂停|暂停一下|暂停公司|恢复|继续|停止|关公司|启动|开始|开公司|启动公司)/u.exec(text);
  if (control !== null) {
    const word = control[2]!;
    if (word.includes("暂停")) return { kind: "command", command: "pause", args: [] };
    if (word.includes("恢复") || word.includes("继续")) return { kind: "command", command: "resume", args: [] };
    if (word.includes("停止") || word.includes("关公司")) return { kind: "command", command: "stop", args: [] };
    return { kind: "command", command: "start", args: [] };
  }

  // 5. View phrases
  if (text.includes("待审批") || text.includes("审批")) return { kind: "view", view: "approvals" };
  if (text.includes("任务")) return { kind: "view", view: "tasks" };
  if (text.includes("员工")) return { kind: "view", view: "employees" };
  if (text.includes("事件")) return { kind: "view", view: "events" };

  // 6. Help
  if (text === "?" || text.includes("帮助")) return { kind: "help" };

  return { kind: "unknown" };
}
