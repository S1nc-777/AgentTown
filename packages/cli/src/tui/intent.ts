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

/** Polite task-openers ("帮我写一个笑话") stripped before verb matching. */
const HELP_PREFIX = /^(帮我|请你|麻烦你|麻烦|我想让你|你帮我|帮我写|帮我做)\s*/u;

const TASK_TITLE_MAX = 40;

export type Intent =
  | { kind: "command"; command: string; args: string[] }
  | {
    kind: "task-create";
    assignee: string | null;
    title: string;
    /** Full free-text request, pre-filled into the wizard as the objective. */
    objective: string | null;
  }
  | { kind: "question"; topic: "employees" | "tasks" | "status" }
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

  // 2. Help markers (both half- and full-width "?").
  if (
    text === "?"
    || text === "？"
    || text === "??"
    || text === "？？"
    || text.includes("帮助")
    || text.includes("怎么用")
    || text.includes("使用说明")
  ) {
    return { kind: "help" };
  }

  // 3. "让 X 做 Y" / "叫 X 实现 Y" / "X 完成 Y" — employee name + task verb.
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
        return taskCreate(employee, match[2].trim());
      }
    } else {
      const match = ASSIGN_VERB.exec(after);
      if (match !== null && match[2] !== undefined && match[2].length > 0 && before.trim().length === 0) {
        return taskCreate(employee, match[2].trim());
      }
    }
  }

  // Polite task-openers ("帮我写一个md文档…") are stripped before the
  // remaining phrase is classified.
  const prefixMatch = HELP_PREFIX.exec(text);
  const rest = prefixMatch === null ? text : text.slice(prefixMatch[0].length);

  // 4. Control phrases first over the stripped text ("帮我暂停一下公司" is
  //    pause, not a task), then task creation from a leading verb, then the
  //    polite-opener fallback ("帮我看看项目" is still a request).
  const control = matchControl(rest) ?? matchControl(text);
  if (control !== null) return control;

  // 5. Generic task creation: "实现登录页面" / "做一个计算器" /
  //    "帮我写一个笑话" — free-form requests pre-fill the full sentence as
  //    the objective so the wizard can be confirmed with plain Enters.
  const generic = TASK_VERB.exec(rest);
  if (generic !== null && generic[2] !== undefined && generic[2].length > 0) {
    return taskCreate(null, generic[2].trim(), rest.trim());
  }
  if (prefixMatch !== null && rest.trim().length > 0) {
    return taskCreate(null, rest.trim(), rest.trim());
  }

  // 6. Questions ("现在有哪些员工" / "任务进度怎么样") — answered with real
  //    data instead of switching views.
  const questionLike = /哪些|有谁|是谁|叫什么|有几个|多少|干嘛|干活|在做什么|怎么样|什么情况|状态|吗|呢/u.test(text);
  if (questionLike) {
    if (/员工|谁在|谁在干活/u.test(text)) return { kind: "question", topic: "employees" };
    if (/任务/u.test(text)) return { kind: "question", topic: "tasks" };
    if (/公司|现在|当前|运行|进展/u.test(text)) return { kind: "question", topic: "status" };
  }

  // 7. View switches — only clear imperatives switch views.
  if (/待审批|审批列表/u.test(text) && /看|切|打开|显示|列表/u.test(text)) {
    return { kind: "view", view: "approvals" };
  }
  if (text.includes("审批")) return { kind: "view", view: "approvals" };
  if (text.includes("事件")) return { kind: "view", view: "events" };
  if (/任务列表|任务视图|看下任务|查看任务/u.test(text)) return { kind: "view", view: "tasks" };
  if (text.includes("任务")) return { kind: "view", view: "tasks" };
  if (/员工列表|员工视图|看下员工|查看员工/u.test(text)) return { kind: "view", view: "employees" };
  if (text.includes("员工")) return { kind: "view", view: "employees" };

  return { kind: "unknown" };
}

function matchControl(text: string): { kind: "command"; command: string; args: string[] } | null {
  const control = /^(请|帮我)?\s*(暂停|暂停一下|暂停公司|恢复|继续|停止|关公司|启动|开始|开公司|启动公司)/u.exec(text);
  if (control === null) return null;
  const word = control[2]!;
  if (word.includes("暂停")) return { kind: "command", command: "pause", args: [] };
  if (word.includes("恢复") || word.includes("继续")) return { kind: "command", command: "resume", args: [] };
  if (word.includes("停止") || word.includes("关公司")) return { kind: "command", command: "stop", args: [] };
  return { kind: "command", command: "start", args: [] };
}

function taskCreate(
  assignee: string | null,
  title: string,
  objective: string | null = null
): Intent {
  const chars = Array.from(title.trim());
  const shortTitle = chars.length > TASK_TITLE_MAX
    ? `${chars.slice(0, TASK_TITLE_MAX).join("")}…`
    : title.trim();
  return {
    kind: "task-create",
    assignee,
    title: shortTitle,
    // A long title that had to be truncated keeps its full text as the
    // objective; callers may also pass the whole request explicitly.
    objective: objective ?? (chars.length > TASK_TITLE_MAX ? title.trim() : null)
  };
}
