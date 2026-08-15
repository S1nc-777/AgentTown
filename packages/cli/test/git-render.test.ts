import { describe, expect, it } from "vitest";
import type {
  ApprovalView,
  DeliveryView,
  EvidenceView,
  GitWorkspaceView
} from "@agenttown/runtime-contract";
import {
  renderApprovals,
  renderDelivery,
  renderEvidence,
  renderGitWorkspaces
} from "../src/git-render.js";

describe("P1B CLI rendering", () => {
  it("renders workspaces in stable employee and task order", () => {
    const views: GitWorkspaceView[] = [
      {
        employeeId: "developer-b",
        taskId: "task-b",
        state: "paused",
        headCommit: "b".repeat(40),
        workspacePath: "C:\\project\\.agenttown\\worktrees\\run-1\\developer-b\\task-b",
        branchRef: "refs/heads/agenttown/run-1/developer-b/task-b"
      },
      {
        employeeId: "developer-a",
        taskId: "task-a",
        state: "completed",
        headCommit: "a".repeat(40),
        workspacePath: "C:\\project\\.agenttown\\worktrees\\run-1\\developer-a\\task-a",
        branchRef: "refs/heads/agenttown/run-1/developer-a/task-a"
      }
    ];

    const output = renderGitWorkspaces(views);

    expect(output.split(/\r?\n/u)[0]).toBe("EMPLOYEE\tTASK\tSTATE\tHEAD\tWORKSPACE");
    expect(output.split(/\r?\n/u)[1]).toContain("developer-a\ttask-a");
  });

  it("renders evidence revision, hash, validations and path", () => {
    const evidence: EvidenceView = {
      runId: "run-1",
      taskId: "task-a",
      revision: 2,
      manifestHash: "a".repeat(64),
      manifestPath: "C:\\project\\.agenttown\\runs\\run-1\\reviews\\task-a\\2\\manifest.json",
      validationOutcomes: [{ commandId: "unit", outcome: "passed" }]
    };

    expect(renderEvidence(evidence)).toContain("revision: 2");
    expect(renderEvidence(evidence)).toContain("unit: passed");
    expect(renderEvidence(evidence)).toContain(evidence.manifestPath);
  });

  it("renders delivery with explicit non-merge and non-push status", () => {
    const delivery: DeliveryView = {
      runId: "run-1",
      originalBranch: "main",
      baseCommit: "1".repeat(40),
      integrationBranch: "refs/heads/agenttown/run-1/integration",
      integrationCommit: "2".repeat(40),
      tasks: [{
        taskId: "task-a",
        employeeId: "developer-a",
        commits: ["2".repeat(40)],
        submissionRevision: 1,
        reviewDecision: "approve",
        validationOutcomes: [{ commandId: "unit", outcome: "passed" }]
      }],
      advisoryFindings: ["Consider documenting the edge case"],
      knownRisks: ["Windows path length"],
      mergedIntoUserBranch: false,
      pushed: false
    };

    const output = renderDelivery(delivery);

    expect(output).toContain("not merged into user branch; not pushed");
    expect(output).toContain(`git diff ${delivery.baseCommit}..${delivery.integrationCommit}`);
    expect(output).toContain(`git log --oneline ${delivery.baseCommit}..${delivery.integrationCommit}`);
    expect(output).toContain("AgentTown did not execute a merge");
  });

  it("renders exact pending command grants", () => {
    const approvals: ApprovalView[] = [{
      approvalId: "grant-1",
      runId: "run-1",
      taskId: "task-a",
      workspaceId: "workspace-a",
      workspacePath: "C:\\project\\workspace-a",
      requestingEmployeeId: "developer-a",
      reason: "suggested_validation_command",
      executable: "pnpm",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 600
    }];

    const output = renderApprovals(approvals);
    expect(output).toContain("grant-1");
    expect(output).toContain("pnpm test");
    expect(output).toContain("developer-a");
  });
});
