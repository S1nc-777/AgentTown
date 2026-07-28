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
      event.actorId,
      event.taskId ?? "-"
    ].join("\t"));
  return ["SEQ\tTIME\tTYPE\tACTOR\tTASK", ...rows].join("\n");
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
