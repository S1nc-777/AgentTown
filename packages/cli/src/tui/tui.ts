import { readFile } from "node:fs/promises";
import { parseCompanyYaml } from "@agenttown/runtime-contract";
import type { ApprovalView, TaskRecord } from "@agenttown/runtime-contract";
import type { EventRecord } from "@agenttown/core";
import { resolveAgentTownPaths } from "../paths.js";
import {
  employeeStatus,
  record,
  requiredNonnegativeInteger,
  requiredString,
  type CliClient
} from "../main.js";
import type { EmployeeStatusView } from "../render.js";
import { describeEventType } from "../render.js";
import { dispatchInput, submitWizardDraft, type DispatchContext } from "./commands.js";
import {
  applyEditorKey,
  createEditor,
  KeyParser,
  rememberHistory
} from "./input.js";
import {
  renderFrame,
  type ChatMessage,
  type TuiSnapshot,
  type ViewId
} from "./layout.js";
import { wizardSubmit, type WizardView } from "./wizard.js";

const REFRESH_MS = 1000;
const EVENT_LIMIT = 50;
const EXIT_CONFIRM_RESET_MS = 5000;
const MAX_CHAT_MESSAGES = 200;
const VIEW_ORDER: ViewId[] = ["chat", "events", "tasks", "employees", "approvals"];

/**
 * Event types that matter to a human watching the company work; they are
 * surfaced in the chat view as brief lines (the events view keeps the full
 * firehose).
 */
const CHAT_WORTHY_EVENTS = new Set([
  "company.started",
  "company.paused",
  "company.resumed",
  "company.stopped",
  "task.created",
  "task.assigned",
  "task.submitted",
  "task.review_requested",
  "task.review_approved",
  "task.review_rejected",
  "task.completed",
  "task.failed",
  "task.blocked",
  "git.integration.committed",
  "git.integration.conflicted",
  "user.approval.requested"
]);

export interface TuiRuntime {
  connectOrStart(root: string, startIfMissing: boolean): Promise<CliClient>;
  stdin: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    setRawMode?(mode: boolean): unknown;
    resume?(): unknown;
    pause?(): unknown;
  };
  stdout: {
    write(chunk: string): boolean;
    columns?: number;
    rows?: number;
    on?(event: "resize", listener: () => void): unknown;
    off?(event: "resize", listener: () => void): unknown;
  };
}

export async function runTui(projectRoot: string, runtime: TuiRuntime): Promise<number> {
  const companyPath = resolveAgentTownPaths(projectRoot).companyPath;
  let companyText: string;
  try {
    companyText = await readFile(companyPath, "utf8");
  } catch {
    await runtime.stdout.write(
      `this project is not initialized (missing ${companyPath}) — run 'agenttown init' first\n`
    );
    return 1;
  }
  const company = parseCompanyYaml(companyText);
  const leader = company.employees.find((employee) => employee.reportsTo === "owner");
  const leaderId = leader?.id ?? company.employees[0]?.id ?? "";

  // TypeScript narrows this to never in the finally block below; the
  // cast keeps the closure assignment legal (runtime value stays null).
  let client: CliClient | null = null as CliClient | null;
  let connected = false;
  let view: ViewId = "chat";
  const chat: ChatMessage[] = [];
  let lastChatEventSequence: number | null = null;
  let events: EventRecord[] = [];
  let tasks: TaskRecord[] = [];
  let approvals: ApprovalView[] = [];
  let employees: EmployeeStatusView[] = [];

  const pushChat = (kind: ChatMessage["kind"], text: string): void => {
    chat.push({ kind, text });
    if (chat.length > MAX_CHAT_MESSAGES) {
      chat.splice(0, chat.length - MAX_CHAT_MESSAGES);
    }
  };
  let status = "unknown";
  let activeTaskCount = 0;
  let pendingApprovalCount = 0;
  let result: { kind: "ok" | "error"; text: string } | null = null;
  let wizard: WizardView | null = null;
  let helpVisible = false;
  let exitPending = false;
  let exitResetTimer: ReturnType<typeof setTimeout> | null = null;
  let exited = false;

  let editor = createEditor();
  const parser = new KeyParser();

  const connect = async (): Promise<void> => {
    if (client !== null || connected) return;
    try {
      client = await runtime.connectOrStart(projectRoot, false);
      connected = true;
      exitPending = false;
    } catch {
      connected = false;
      status = "未运行";
    }
  };

  const refresh = async (): Promise<void> => {
    if (client === null) {
      await connect();
      if (client === null) return;
    }
    try {
      const snapshot = record(
        await client.request("status.snapshot", { companyId: "company" }),
        "status.snapshot"
      );
      status = requiredString(snapshot.status, "status.snapshot status");
      activeTaskCount = requiredNonnegativeInteger(
        snapshot.activeTaskCount,
        "status.snapshot activeTaskCount"
      );
      pendingApprovalCount = requiredNonnegativeInteger(
        snapshot.pendingApprovalCount,
        "status.snapshot pendingApprovalCount"
      );
      if (Array.isArray(snapshot.employees)) {
        employees = snapshot.employees
          .map(employeeStatus)
          .sort((left, right) => left.id.localeCompare(right.id));
      }
      tasks = (await client.request("tasks.list", { companyId: "company" })) as TaskRecord[];
      events = (await client.request("events.list", {
        afterSequence: 0,
        limit: EVENT_LIMIT
      })) as EventRecord[];
      // Surface newly-arrived key events in the chat view. The first pull
      // seeds the high-water mark without replaying history.
      if (lastChatEventSequence === null) {
        lastChatEventSequence = events.reduce(
          (max, event) => Math.max(max, event.sequence),
          0
        );
      } else {
        for (const event of events) {
          if (
            event.sequence > lastChatEventSequence
            && CHAT_WORTHY_EVENTS.has(event.type)
          ) {
            const description = describeEventType(event.type) || event.type;
            pushChat("event", `${description} ${event.actorId}${event.taskId === null ? "" : ` ${event.taskId}`}`);
          }
        }
        lastChatEventSequence = events.reduce(
          (max, event) => Math.max(max, event.sequence),
          lastChatEventSequence
        );
      }
      try {
        approvals = (await client.request("approvals.list", {})) as ApprovalView[];
      } catch {
        approvals = [];
      }
      connected = true;
    } catch {
      connected = false;
      status = "未运行";
      await client?.close().catch(() => undefined);
      client = null;
    }
  };

  let painted: { lines: string[]; width: number; height: number } | null = null;
  let lastCursor = "";

  const render = (): void => {
    const snapshot: TuiSnapshot = {
      status,
      activeTaskCount,
      pendingApprovalCount,
      employeeCount: employees.length,
      view,
      chat,
      events,
      tasks,
      employees,
      approvals,
      result,
      input: editor.text,
      inputCursor: editor.cursor,
      wizard,
      helpVisible,
      connected
    };
    const width = runtime.stdout.columns ?? 80;
    const height = runtime.stdout.rows ?? 24;
    const { frame, cursorRow, cursorCol } = renderFrame(snapshot, width, height);
    const lines = frame.split("\n");
    const placeCursor = `\x1b[${cursorRow};${cursorCol}H\x1b[?25h`;

    if (
      painted === null
      || painted.width !== width
      || painted.height !== height
    ) {
      // First paint or resize: clear the screen AND the scrollback once,
      // then draw everything. No trailing newline — writing exactly
      // `height` rows must not push the terminal into scrolling.
      runtime.stdout.write(`\x1b[2J\x1b[3J\x1b[H\x1b[?25l${frame}${placeCursor}`);
      painted = { lines, width, height };
      lastCursor = placeCursor;
      return;
    }

    // Incremental repaint: rewrite only rows whose text changed, then place
    // the cursor. When nothing changed and the cursor is already in place,
    // emit NOTHING — a static screen must not repaint every second (no
    // flicker, no scrolling garbage on terminals without clear support).
    let patch = "";
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== painted.lines[index]) {
        patch += `\x1b[${index + 1};1H${lines[index]}\x1b[K`;
      }
    }
    if (patch.length === 0 && placeCursor === lastCursor) return;
    runtime.stdout.write(`\x1b[?25l${patch}${placeCursor}`);
    painted = { lines, width, height };
    lastCursor = placeCursor;
  };

  const showResult = (text: string, ok = true): void => {
    result = { kind: ok ? "ok" : "error", text };
    helpVisible = false;
  };

  const applyWizardOutcome = (outcome: ReturnType<typeof wizardSubmit>): void => {
    if (outcome.kind === "continue") {
      wizard = outcome.view;
    } else if (outcome.kind === "submit") {
      wizard = null;
      void submitWizardDraft(outcome.draft, {
        projectRoot,
        connectOrStart: runtime.connectOrStart,
        employees: company.employees,
        leaderId
      }).then((text) => {
        pushChat("system", `✔ ${text}`);
        showResult(text);
        render();
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        pushChat("system", `✘ ${message}`);
        showResult(message, false);
        render();
      });
    } else {
      wizard = null;
      pushChat("system", "已取消任务创建");
      showResult("已取消任务创建");
    }
  };

  const handleSubmit = (text: string): void => {
    const trimmed = text.trim();
    pushChat("user", trimmed);
    const ctx: DispatchContext = {
      projectRoot,
      connectOrStart: runtime.connectOrStart,
      employees: company.employees,
      leaderId
    };
    void dispatchInput(text, ctx).then((outcome) => {
      switch (outcome.kind) {
        case "result":
          pushChat("system", `${outcome.ok ? "✔ " : "✘ "}${outcome.text}`);
          showResult(outcome.text, outcome.ok);
          break;
        case "view":
          view = outcome.view;
          pushChat("system", `✔ 已切换到${viewLabel(outcome.view)}视图`);
          result = null;
          helpVisible = false;
          break;
        case "wizard":
          wizard = outcome.view;
          result = null;
          helpVisible = false;
          break;
        case "help":
          helpVisible = !helpVisible;
          result = null;
          break;
        case "unknown":
          pushChat("system", `✘ 没看懂「${trimmed}」。输入 ? 查看帮助`);
          showResult(`没看懂「${trimmed}」。输入 ? 查看帮助`, false);
          break;
      }
      render();
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      pushChat("system", `✘ ${message}`);
      showResult(message, false);
      render();
    });
  };

  function viewLabel(id: ViewId): string {
    switch (id) {
      case "chat": return "对话";
      case "events": return "事件";
      case "tasks": return "任务";
      case "employees": return "员工";
      case "approvals": return "审批";
    }
  }

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const key of parser.feed(text)) {
      if (wizard !== null) {
        if (key.type === "enter") {
          const outcome = wizardSubmit(wizard, editor.text);
          editor = { ...editor, text: "", cursor: 0, historyIndex: -1 };
          applyWizardOutcome(outcome);
        } else if (key.type === "escape") {
          wizard = null;
          editor = { ...editor, text: "", cursor: 0, historyIndex: -1 };
          showResult("已取消任务创建");
        } else {
          const applied = applyEditorKey(editor, key);
          editor = applied.editor;
        }
        continue;
      }

      const applied = applyEditorKey(editor, key);
      editor = applied.editor;

      if (applied.effect.type === "submit") {
        const submitted = applied.effect.text;
        if (submitted.trim().length > 0) {
          editor.history = rememberHistory(editor.history, submitted);
          handleSubmit(submitted);
        }
        editor = { ...editor, text: "", cursor: 0, historyIndex: -1 };
        continue;
      }
      if (applied.effect.type === "clear-input") continue;

      if (key.type === "tab") {
        view = VIEW_ORDER[(VIEW_ORDER.indexOf(view) + 1) % VIEW_ORDER.length]!;
        result = null;
      } else if (key.type === "ctrl-c") {
        if (exitPending) {
          exited = true;
          return;
        }
        exitPending = true;
        showResult("再按一次 Ctrl+C 退出（公司不会停止）", false);
        if (exitResetTimer !== null) clearTimeout(exitResetTimer);
        exitResetTimer = setTimeout(() => {
          exitPending = false;
          exitResetTimer = null;
        }, EXIT_CONFIRM_RESET_MS);
      } else if (key.type === "ctrl-l") {
        result = null;
        helpVisible = false;
      } else if (key.type === "char" && key.value === "s" && !connected) {
        handleSubmit("start");
      }
    }
    render();
  };

  runtime.stdin.on("data", onData);
  runtime.stdin.setRawMode?.(true);
  runtime.stdin.resume?.();
  const onResize = () => render();
  runtime.stdout.on?.("resize", onResize);

  const interval = setInterval(() => {
    void refresh().then(render);
  }, REFRESH_MS);

  try {
    await refresh();
    render();
    // Drive the event loop until the user confirms exit. The refresh timer
    // keeps the process alive.
    while (!exited) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return 0;
  } finally {
    clearInterval(interval);
    runtime.stdin.off?.("data", onData);
    runtime.stdin.setRawMode?.(false);
    runtime.stdin.pause?.();
    runtime.stdout.off?.("resize", onResize);
    runtime.stdout.write("\x1b[?25h\x1b[0m\n");
    await client?.close().catch(() => undefined);
  }
}
