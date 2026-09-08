import type { EventRecord } from "@agenttown/core";
import type { ApprovalView, TaskRecord } from "@agenttown/runtime-contract";
import { describeEventType, type EmployeeStatusView } from "../render.js";
import type { WizardView } from "./wizard.js";

export type ViewId = "chat" | "events" | "tasks" | "employees" | "approvals";

export interface ChatMessage {
  kind: "user" | "system" | "event";
  text: string;
}

export interface TuiSnapshot {
  status: string;
  activeTaskCount: number;
  pendingApprovalCount: number;
  employeeCount: number;
  view: ViewId;
  chat: readonly ChatMessage[];
  events: readonly EventRecord[];
  tasks: readonly TaskRecord[];
  employees: readonly EmployeeStatusView[];
  approvals: readonly ApprovalView[];
  result: { kind: "ok" | "error"; text: string } | null;
  input: string;
  inputCursor: number;
  wizard: WizardView | null;
  helpVisible: boolean;
  connected: boolean;
}

export interface RenderFrame {
  frame: string;
  cursorRow: number;
  cursorCol: number;
}

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

export function visualWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += WIDE.test(ch) ? 2 : 1;
  }
  return width;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visualWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const chWidth = WIDE.test(ch) ? 2 : 1;
    if (used + chWidth > width - 1) break;
    out += ch;
    used += chWidth;
  }
  return `${out}…`;
}

const VIEW_LABELS: Record<ViewId, string> = {
  chat: "[对话]",
  events: "[事件]",
  tasks: "[任务]",
  employees: "[员工]",
  approvals: "[审批]"
};

const RESULT_HEIGHT = 3;

export function renderFrame(snapshot: TuiSnapshot, width: number, height: number): RenderFrame {
  const dot = snapshot.connected ? "●" : "○";
  const statusLine = truncate(
    `${dot} ${snapshot.status} │ 任务 ${snapshot.activeTaskCount} │ 待审批 ${snapshot.pendingApprovalCount} │ 员工 ${snapshot.employeeCount} │ ${VIEW_LABELS[snapshot.view]}`,
    width
  );

  const resultLines = buildResultLines(snapshot, width);
  const resultHeight = Math.min(RESULT_HEIGHT, resultLines.length);
  const viewHeight = Math.max(1, height - 1 - resultHeight - 1);

  const viewLines = renderView(snapshot, width, viewHeight);
  // Pad the view area to exactly viewHeight rows so the input line is
  // always the bottom row and cursorRow = height stays correct even for
  // sparse/empty views.
  while (viewLines.length < viewHeight) viewLines.push("");

  const inputLine = `> ${snapshot.input}`;
  const lines = [statusLine, ...viewLines, ...resultLines, inputLine];
  while (lines.length < height) lines.push("");
  const frame = lines.slice(0, height).join("\n");

  const cursorCol = 1 + visualWidth(`> ${snapshot.input.slice(0, snapshot.inputCursor)}`);
  const cursorRow = height; // input line is the last row
  return { frame, cursorRow, cursorCol };
}

function buildResultLines(snapshot: TuiSnapshot, width: number): string[] {
  if (snapshot.wizard !== null) {
    const { wizard } = snapshot;
    const preview = wizard.preview;
    return [
      truncate(`▶ 向导：${wizard.prompt}`, width),
      truncate(
        `  标题：${preview.title || "—"} │ 目标：${preview.objective || "—"}`,
        width
      ),
      ...(wizard.error !== null
        ? [truncate(`  ⚠ ${wizard.error}`, width)]
        : [truncate("  确认后任务交给 leader 分配开发，回车继续", width)])
    ];
  }
  if (snapshot.helpVisible) {
    return [
      truncate("快捷键：Tab 切换视图 │ ↑↓ 历史 │ Ctrl+C 退出（两次）│ Ctrl+L 清空结果", width),
      truncate("直接说需求即可，例如：帮我写一个使用说明文档 │ 暂停 │ 公司现在怎么样", width),
      truncate("命令：start status tasks pause resume stop timeline │ ? 隐藏帮助", width)
    ];
  }
  if (snapshot.result !== null) {
    const prefix = snapshot.result.kind === "ok" ? "✔" : "✘";
    return [truncate(`${prefix} ${snapshot.result.text}`, width)];
  }
  return [];
}

function renderView(snapshot: TuiSnapshot, width: number, height: number): string[] {
  switch (snapshot.view) {
    case "chat": {
      if (snapshot.chat.length === 0) {
        return snapshot.connected
          ? [
              truncate("（还没有对话）", width),
              "",
              truncate("直接说需求，例如：", width),
              truncate("  帮我写一个使用说明文档，保存在当前目录", width),
              truncate("  输入 ? 查看全部命令", width)
            ]
          : notRunningLines(width);
      }
      const rows = snapshot.chat.slice(-height);
      return rows.map((message) => {
        // system texts already carry their own ✔/✘ prefix from the caller.
        const prefix = message.kind === "user" ? "❯ "
          : message.kind === "event" ? "· "
          : "";
        return truncate(prefix + message.text, width);
      });
    }
    case "events": {
      const rows = [...snapshot.events]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-height);
      if (rows.length === 0) {
        return snapshot.connected
          ? [
              truncate("（暂无事件）", width),
              "",
              truncate("公司已运行，还没有活动。直接说需求：", width),
              truncate("  帮我写一个使用说明文档    任务会由 leader 分配开发", width),
              truncate("  输入 ? 查看全部命令", width)
            ]
          : notRunningLines(width);
      }
      return rows.map((event) => {
        const time = event.occurredAt.length >= 19
          ? event.occurredAt.slice(11, 19)
          : event.occurredAt;
        const description = describeEventType(event.type) || event.type;
        const detail = JSON.stringify(event.payload ?? {});
        const suffix = detail === "{}" ? "" : ` ${detail}`;
        return truncate(`${time} ${description}${suffix} ${event.actorId}`, width);
      });
    }
    case "tasks": {
      const rows = [...snapshot.tasks]
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, height);
      if (rows.length === 0) {
        return snapshot.connected
          ? [truncate("（暂无任务）", width), "", truncate("有任务后会显示在这里。输入 ? 查看帮助", width)]
          : notRunningLines(width);
      }
      return rows.map((task) =>
        truncate(`${task.id} ${task.status} ${task.ownerEmployeeId ?? "-"} ${task.title}`, width));
    }
    case "employees": {
      if (snapshot.employees.length === 0) {
        return snapshot.connected
          ? [truncate("（暂无员工）", width), "", truncate("员工来自 .agenttown/company.yaml", width)]
          : notRunningLines(width);
      }
      return snapshot.employees.slice(0, height).map((employee) =>
        truncate(
          `${employee.id} (${employee.role}) ${employee.status} task=${employee.currentTaskId ?? "-"}`,
          width
        ));
    }
    case "approvals": {
      if (snapshot.approvals.length === 0) {
        return snapshot.connected
          ? [truncate("（暂无待审批）", width), "", truncate("审批需求会出现在这里。输入 ? 查看帮助", width)]
          : notRunningLines(width);
      }
      return snapshot.approvals.slice(0, height).map((approval) =>
        truncate(
          `${approval.approvalId} ${approval.taskId} ${approval.requestingEmployeeId} ${approval.reason}`,
          width
        ));
    }
  }
}

function notRunningLines(width: number): string[] {
  return [
    truncate("○ 公司未运行", width),
    "",
    truncate("按 s 键或输入 start 启动公司", width),
    truncate("启动后这里会实时显示员工的活动", width)
  ];
}
