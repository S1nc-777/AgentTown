import type { EventRecord } from "@agenttown/core";
import type {
  TaskRecord,
  UsageSnapshot
} from "@agenttown/runtime-contract";

export interface CompanyStatusView {
  companyId: string;
  status: string;
  activeTaskCount: number;
  pendingApprovalCount: number;
}

export interface EmployeeStatusView {
  id: string;
  role: string;
  status: string;
  currentTaskId: string | null;
  usage: UsageSnapshot;
}

export function renderUsage(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

/**
 * Human-friendly descriptions for the event types a user is likely to see.
 * Unknown types fall back to an empty description so output stays tidy.
 */
const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "company.created": "公司已创建",
  "company.started": "公司已启动",
  "company.pausing": "公司暂停中",
  "company.paused": "公司已暂停",
  "company.resumed": "公司已恢复",
  "company.recovered": "公司已从检查点恢复",
  "company.checkpointed": "已保存检查点",
  "company.completion_requested": "领导请求完成公司",
  "company.stop_requested": "公司停止中",
  "session.started": "员工会话已启动",
  "session.recovered": "员工会话已恢复",
  "session.rebuilt": "员工会话已重建",
  "session.interrupted": "员工会话被中断",
  "session.start_rolled_back": "会话启动已回滚",
  "task.created": "任务已创建",
  "task.assigned": "任务已分配",
  "task.started": "任务已开始",
  "task.submitted": "任务已提交",
  "task.review_requested": "已请求审核",
  "task.review_approved": "审核通过",
  "task.review_rejected": "审核拒绝",
  "task.completed": "任务已完成",
  "task.blocked": "任务已阻塞",
  "task.failed": "任务失败",
  "task.retry_scheduled": "已安排任务重试",
  "git.run.created": "Git 运行已创建",
  "git.run.paused": "Git 运行已暂停",
  "git.run.resumed": "Git 运行已恢复",
  "git.workspace.created": "任务工作区已创建",
  "git.workspace.advanced": "工作区提交已推进",
  "git.workspace.removed": "工作区已移除",
  "git.submission.validated": "提交已通过校验",
  "git.submission.commits_resolved": "提交列表已自动解析",
  "review.package.created": "审核包已生成",
  "git.integration.prepared": "集成已准备",
  "git.integration.committed": "代码已集成",
  "git.integration.conflicted": "集成发生冲突",
  "git.integration.validation_failed": "集成验证失败",
  "validation.completed": "验证命令已完成",
  "action.proposed": "提议动作",
  "action.rejected": "动作被拒绝",
  "task.execution_error": "执行出错",
  "output.completed": "输出完成",
  "usage.updated": "用量已更新",
  "user.approval.requested": "需要用户审批"
};

export function describeEventType(type: string): string {
  return EVENT_DESCRIPTIONS[type] ?? "";
}

export function renderTasks(tasks: readonly TaskRecord[]): string {
  const rows = [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => [
      task.id,
      task.status,
      task.ownerEmployeeId ?? "-",
      task.title
    ].join("\t"));
  return ["ID\tSTATUS\tOWNER\tTITLE", ...rows].join("\n");
}

export function renderTimeline(events: readonly EventRecord[]): string {
  const rows = [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [
      String(event.sequence),
      event.occurredAt,
      event.type,
      describeEventType(event.type),
      event.actorId,
      event.taskId ?? "-"
    ].join("\t"));
  return ["SEQ\tTIME\tTYPE\t说明\tACTOR\tTASK", ...rows].join("\n");
}

export function renderCompanyStatus(status: CompanyStatusView): string {
  return [
    `company: ${status.companyId}`,
    `status: ${status.status}`,
    `active tasks: ${status.activeTaskCount}`,
    `pending approvals: ${status.pendingApprovalCount}`
  ].join("\n");
}

export function renderEmployee(employee: EmployeeStatusView): string {
  return [
    `${employee.id} (${employee.role})`,
    `status: ${employee.status}`,
    `task: ${employee.currentTaskId ?? "-"}`,
    `usage: input=${renderUsage(employee.usage.inputTokens)} `
      + `output=${renderUsage(employee.usage.outputTokens)} `
      + `context=${renderUsage(employee.usage.contextTokens)}`
  ].join("\n");
}

export {
  renderApprovals,
  renderCleanupPreview,
  renderDelivery,
  renderEvidence,
  renderGitWorkspaces
} from "./git-render.js";
