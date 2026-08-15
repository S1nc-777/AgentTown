import type {
  ApprovalView,
  CleanupPreview,
  DeliveryView,
  EvidenceView,
  GitWorkspaceView
} from "@agenttown/runtime-contract";

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function renderGitWorkspaces(workspaces: readonly GitWorkspaceView[]): string {
  const rows = [...workspaces]
    .sort((left, right) =>
      (left.employeeId ?? "-").localeCompare(right.employeeId ?? "-", "en")
      || (left.taskId ?? "-").localeCompare(right.taskId ?? "-", "en")
      || left.workspacePath.localeCompare(right.workspacePath, "en"))
    .map((workspace) => [
      workspace.employeeId ?? "-",
      workspace.taskId ?? "-",
      workspace.state,
      shortSha(workspace.headCommit),
      workspace.workspacePath
    ].join("\t"));
  return ["EMPLOYEE\tTASK\tSTATE\tHEAD\tWORKSPACE", ...rows].join("\n");
}

export function renderEvidence(evidence: EvidenceView): string {
  const validations = evidence.validationOutcomes.length === 0
    ? "none"
    : evidence.validationOutcomes
      .map(({ commandId, outcome }) => `${commandId}: ${outcome}`)
      .join(", ");
  return [
    `task: ${evidence.taskId}`,
    `revision: ${evidence.revision}`,
    `manifest hash: ${evidence.manifestHash}`,
    `validations: ${validations}`,
    `path: ${evidence.manifestPath}`
  ].join("\n");
}

export function renderDelivery(delivery: DeliveryView): string {
  const tasks = delivery.tasks.length === 0
    ? ["- none"]
    : delivery.tasks.map((task) => {
      const validations = task.validationOutcomes.length === 0
        ? "none"
        : task.validationOutcomes
          .map(({ commandId, outcome }) => `${commandId}:${outcome}`)
          .join(", ");
      return `- ${task.taskId} (${task.employeeId}) revision ${task.submissionRevision}; `
        + `review=${task.reviewDecision}; tests=${validations}; commits=${task.commits.join(",")}`;
    });
  const advisory = delivery.advisoryFindings.length === 0
    ? ["- none"]
    : delivery.advisoryFindings.map((finding) => `- ${finding}`);
  const risks = delivery.knownRisks.length === 0
    ? ["- none"]
    : delivery.knownRisks.map((risk) => `- ${risk}`);
  return [
    `run: ${delivery.runId}`,
    `original branch: ${delivery.originalBranch}`,
    `base commit: ${delivery.baseCommit}`,
    `integration branch: ${delivery.integrationBranch}`,
    `integration commit: ${delivery.integrationCommit}`,
    "tasks:",
    ...tasks,
    "advisory findings:",
    ...advisory,
    "known risks:",
    ...risks,
    "inspection commands:",
    `git diff ${delivery.baseCommit}..${delivery.integrationCommit}`,
    `git log --oneline ${delivery.baseCommit}..${delivery.integrationCommit}`,
    "AgentTown did not execute a merge.",
    "not merged into user branch; not pushed"
  ].join("\n");
}

export function renderApprovals(approvals: readonly ApprovalView[]): string {
  const rows = [...approvals]
    .sort((left, right) => left.approvalId.localeCompare(right.approvalId, "en"))
    .map((approval) => [
      approval.approvalId,
      approval.requestingEmployeeId,
      approval.taskId,
      [approval.executable, ...approval.args].join(" "),
      approval.cwd,
      String(approval.timeoutSeconds),
      approval.reason
    ].join("\t"));
  return ["ID\tEMPLOYEE\tTASK\tCOMMAND\tCWD\tTIMEOUT\tREASON", ...rows].join("\n");
}

export function renderCleanupPreview(preview: CleanupPreview): string {
  return [
    `run: ${preview.runId}`,
    `worktrees: ${preview.workspaces.length}`,
    `branches: ${preview.branchRefs.length}`,
    `evidence roots: ${preview.evidenceRoots.length}`,
    `fingerprint: ${preview.fingerprint}`
  ].join("\n");
}
