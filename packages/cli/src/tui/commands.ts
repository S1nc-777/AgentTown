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
 * Commands that are only shown in the TUI; their confirmation flows stay in
 * the one-shot CLI (see the TUI spec, "明确不做").
 */
const READ_ONLY_COMMANDS = new Set(["approve", "reject", "stop", "cleanup"]);

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
      // start must detach inside the TUI so the main loop is not blocked by
      // the foreground event stream.
      const args = intent.command === "start" && !intent.args.includes("--detach")
        ? [...intent.args, "--detach"]
        : intent.args;
      const { text, ok } = await runCliCapture(intent.command, args, ctx);
      return { kind: "result", ok, text };
    }
    case "task-create": {
      const candidates = ctx.employees
        .filter((employee) => employee.workspace === "git_worktree")
        .map((employee) => employee.id);
      // No explicit assignee → default to the first developer so a task the
      // user drops on the company actually gets picked up (a draft task has
      // no one to run it until a leader assigns it).
      const assignee = intent.assignee ?? (candidates.length > 0 ? candidates[0]! : null);
      return {
        kind: "wizard",
        view: startWizard(candidates, {
          assignee,
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
    await client.request("action.dispatch", { action: proposal });
    if (draft.assignee !== null) {
      await client.request("action.dispatch", {
        action: {
          schemaVersion: 1 as const,
          actionId: randomUUID(),
          type: "task.assign" as const,
          actorEmployeeId: ctx.leaderId,
          taskId,
          payload: { assignee: draft.assignee },
          reason: "assigned by user from the TUI wizard",
          causationEventId: null
        }
      });
    }
    return `任务已创建：${taskId}${draft.assignee !== null ? ` → ${draft.assignee}` : ""}（${draft.title}）`;
  } catch (error) {
    return `创建任务失败：${error instanceof Error ? error.message : String(error)}`;
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
