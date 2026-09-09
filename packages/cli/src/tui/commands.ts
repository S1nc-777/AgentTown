import { randomUUID } from "node:crypto";
import type { EmployeeDefinition } from "@agenttown/runtime-contract";
import {
  runCli,
  type BackpressureWritable,
  type CliClient
} from "../main.js";
import { parseIntent } from "./intent.js";
import { startWizard, type WizardDraft, type WizardView } from "./wizard.js";
import type { ViewId } from "./layout.js";

export interface DispatchContext {
  projectRoot: string;
  connectOrStart(root: string, startIfMissing: boolean): Promise<CliClient>;
  employees: readonly EmployeeDefinition[];
  leaderId: string;
}

export type DispatchOutcome =
  | { kind: "result"; text: string; ok: boolean }
  | { kind: "question"; topic: "employees" | "tasks" | "status" }
  | { kind: "view"; view: ViewId }
  | { kind: "wizard"; view: WizardView }
  | { kind: "help" }
  | { kind: "unknown" };

/**
 * Commands whose confirmation flows stay in the one-shot CLI; inside the TUI
 * they are only explained. `stop` is the exception: it is executable in the
 * TUI but requires the explicit "--yes" flag (see dispatch below).
 */
const READ_ONLY_COMMANDS = new Set(["approve", "reject", "cleanup"]);

export async function dispatchInput(
  input: string,
  ctx: DispatchContext
): Promise<DispatchOutcome> {
  const intent = parseIntent(input, ctx.employees.map((employee) => employee.id));
  switch (intent.kind) {
    case "command": {
      if (READ_ONLY_COMMANDS.has(intent.command)) {
        return {
          kind: "result",
          ok: false,
          text: `「${intent.command}」需要显式确认：请退出 TUI 后运行 'agenttown ${intent.command} ...'`
        };
      }
      // Stopping the company kills every employee session — require the same
      // explicit confirmation as the one-shot CLI (which would otherwise
      // prompt on stdin and clash with the TUI's raw key handling).
      if (intent.command === "stop" && !intent.args.includes("--yes")) {
        return {
          kind: "result",
          ok: false,
          text: "停止公司将断开所有员工。确认请输入：stop --yes"
        };
      }
      // start must detach inside the TUI so the main loop is not blocked by
      // the foreground event stream.
      const args = intent.command === "start" && !intent.args.includes("--detach")
        ? [...intent.args, "--detach"]
        : intent.args;
      const { text, ok } = await runCliCapture(intent.command, args, ctx);
      return { kind: "result", ok, text };
    }
    case "task-create": {
      // The wizard does not ask for an assignee: the task is handed to the
      // leader drive, which assigns it to a developer.
      return {
        kind: "wizard",
        view: startWizard({
          title: intent.title,
          ...(intent.objective === null ? {} : { objective: intent.objective })
        })
      };
    }
    case "question":
      return { kind: "question", topic: intent.topic };
    case "view":
      return { kind: "view", view: intent.view };
    case "help":
      return { kind: "help" };
    case "unknown":
      return { kind: "unknown" };
  }
}

export async function submitWizardDraft(
  draft: WizardDraft,
  ctx: DispatchContext
): Promise<string> {
  const client = await ctx.connectOrStart(ctx.projectRoot, true);
  try {
    const taskId = `task-${randomUUID()}`;
    const proposal = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      type: "task.propose" as const,
      actorEmployeeId: ctx.leaderId,
      taskId,
      payload: {
        title: draft.title,
        objective: draft.objective,
        acceptanceCriteria: draft.acceptanceCriteria.length > 0
          ? draft.acceptanceCriteria
          : [draft.objective],
        dependencies: [] as string[]
      },
      reason: "created by user from the TUI wizard",
      causationEventId: null
    };
    // Assignment strategy:
    // - All-fake companies have no autonomous leader (leader driving is only
    //   enabled for real-agent companies), so the user's request is assigned
    //   directly to the first git_worktree developer here.
    // - Companies with a real-agent leader get a propose only; the core wakes
    //   the leader drive, and the leader picks the developer itself.
    await client.request("action.dispatch", { action: proposal });
    const leaderIsFake = ctx.employees.find((employee) => employee.id === ctx.leaderId)?.agent === "fake";
    const hasRealAgents = ctx.employees.some((employee) => employee.agent !== "fake");
    if (leaderIsFake && !hasRealAgents) {
      const developers = ctx.employees
        .filter((employee) => employee.workspace === "git_worktree")
        .map((employee) => employee.id);
      const assignee = developers.length > 0 ? developers[0]! : null;
      if (assignee !== null) {
        await client.request("action.dispatch", {
          action: {
            schemaVersion: 1 as const,
            actionId: randomUUID(),
            type: "task.assign" as const,
            actorEmployeeId: ctx.leaderId,
            taskId,
            payload: { assignee },
            reason: "fake-company auto assignment for a user request",
            causationEventId: null
          }
        });
        return `任务已创建：${taskId}（${draft.title}），已分配给 ${assignee}`;
      }
    }
    return `任务已创建：${taskId}（${draft.title}），等待 leader 分配开发`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("orchestrator is not dispatching")) {
      return "公司未在运行（blocked/paused）：按 Ctrl+C 退出，运行 'agenttown stop --yes'，再运行 'agenttown' 并输入 start";
    }
    return `创建任务失败：${message}`;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function runCliCapture(
  command: string,
  args: string[],
  ctx: DispatchContext
): Promise<{ text: string; ok: boolean }> {
  const chunks: string[] = [];
  const stdout: BackpressureWritable = {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    once() {
      throw new Error("unexpected drain");
    }
  };
  try {
    const code = await runCli([command, ...args], ctx.projectRoot, {
      connectOrStart: ctx.connectOrStart,
      stdout
    });
    return { text: chunks.join("").trim(), ok: code === 0 };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), ok: false };
  }
}
