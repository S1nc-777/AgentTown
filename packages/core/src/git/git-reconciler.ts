import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  GitCheckpoint,
  GitRunRecord,
  GitWorkspaceRecord,
  IntegrationAttemptRecord,
  ReconciliationClassification,
  ReconciliationResult,
  ReviewPackageRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { CoreStore, type ApprovalRecord, type NewEvent } from "../storage/core-store.js";
import { GitCommandRunner } from "./git-command.js";

interface ReconciliationWorkspaceManager {
  removeVerifiedWorkspace(workspaceId: string): Promise<void>;
}

interface ReconciliationEvidenceBuilder {
  verify(record: ReviewPackageRecord): Promise<ReviewPackageRecord>;
}

interface ReconciliationGit {
  run: GitCommandRunner["run"];
}

interface ReconciliationConflictService {
  completeResolution(input: {
    attempt: IntegrationAttemptRecord;
    submission: NonNullable<ReturnType<CoreStore["getGitSubmission"]>>;
    task: TaskRecord;
    run: GitRunRecord;
    integrationWorkspace: GitWorkspaceRecord;
    events: readonly [NewEvent, NewEvent];
  }): Promise<void>;
}

export interface GitReconcilerOptions {
  store: CoreStore;
  companyId: string;
  workspaceManager: ReconciliationWorkspaceManager;
  evidenceBuilder: ReconciliationEvidenceBuilder;
  git?: ReconciliationGit;
  conflictService?: ReconciliationConflictService;
}

type Discrepancy = ReconciliationResult["discrepancies"][number];

interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

function pathKey(path: string): string {
  const normalized = resolve(path).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseWorktrees(stdout: string): WorktreeEntry[] {
  return stdout.trim().length === 0
    ? []
    : stdout.trim().split(/\r?\n\r?\n/u).map((block) => {
        const fields = new Map<string, string>();
        for (const line of block.split(/\r?\n/u)) {
          const separator = line.indexOf(" ");
          fields.set(
            separator === -1 ? line : line.slice(0, separator),
            separator === -1 ? "" : line.slice(separator + 1)
          );
        }
        return {
          path: fields.get("worktree") ?? "",
          head: fields.get("HEAD") ?? null,
          branch: fields.get("branch") ?? null
        };
      });
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function missingEvidence(error: unknown): boolean {
  return error instanceof Error
    && /\b(?:missing|not found|ENOENT|deleted)\b/iu.test(error.message);
}

function canonicalDiscrepancies(discrepancies: readonly Discrepancy[]): Discrepancy[] {
  return [...discrepancies].sort((left, right) =>
    `${left.kind}\u0000${left.expected ?? ""}\u0000${left.actual ?? ""}`.localeCompare(
      `${right.kind}\u0000${right.expected ?? ""}\u0000${right.actual ?? ""}`,
      "en"
    ));
}

export class GitReconciler {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #workspaceManager: ReconciliationWorkspaceManager;
  readonly #evidenceBuilder: ReconciliationEvidenceBuilder;
  readonly #git: ReconciliationGit;
  readonly #conflictService: ReconciliationConflictService | undefined;

  constructor(options: GitReconcilerOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#workspaceManager = options.workspaceManager;
    this.#evidenceBuilder = options.evidenceBuilder;
    this.#git = options.git ?? new GitCommandRunner();
    this.#conflictService = options.conflictService;
  }

  async reconcile(runId: string): Promise<ReconciliationResult> {
    const run = this.#store.getGitRun(runId);
    if (run === null || run.companyId !== this.#companyId) {
      return this.#stop(runId, "missing", [{
        kind: "run",
        expected: runId,
        actual: null
      }]);
    }
    const discrepancies: Discrepancy[] = [];
    let classification: ReconciliationClassification = "verified";
    const actualRef = await this.#readRef(run);
    const requiredCommits = new Set<string>([
      run.baseCommit,
      run.integrationCommit,
      ...this.#store.listGitWorkspaces(runId).map(({ headCommit }) => headCommit),
      ...this.#store.listIntegrationAttempts(runId).flatMap((candidate) => [
        candidate.expectedOldCommit,
        ...(candidate.candidateCommit === null ? [] : [candidate.candidateCommit])
      ])
    ]);
    for (const commit of requiredCommits) {
      if (!await this.#commitExists(run, commit)) {
        return this.#stop(runId, "missing", [{
          kind: "commit",
          expected: commit,
          actual: null
        }]);
      }
    }
    const prepared = this.#store.listIntegrationAttempts(runId)
      .filter(({ status }) => status === "prepared");
    if (prepared.length > 1) {
      discrepancies.push({
        kind: "prepared_attempt_count",
        expected: "0 or 1",
        actual: String(prepared.length)
      });
      return this.#stop(runId, "tampered", discrepancies);
    }
    const attempt = prepared[0];
    if (attempt !== undefined) {
      if (actualRef === attempt.expectedOldCommit) {
        const candidateProblem = await this.#verifyOldShaCandidate(run, attempt);
        if (candidateProblem !== null) {
          return this.#stop(
            runId,
            candidateProblem.classification,
            candidateProblem.discrepancies
          );
        }
        try {
          await this.#rollbackPrepared(run, attempt);
        } catch (error) {
          const actual = error instanceof Error ? error.message : String(error);
          return this.#stop(runId, missingEvidence(error) ? "missing" : "tampered", [{
            kind: `candidate_cleanup:${attempt.attemptId}`,
            expected: "exact verified candidate cleanup",
            actual
          }]);
        }
        classification = "rolled_back_recovery";
      } else if (attempt.candidateCommit !== null
        && actualRef === attempt.candidateCommit) {
        try {
          await this.#completePrepared(run, attempt);
        } catch (error) {
          const kind = missingEvidence(error) ? "missing" : "tampered";
          discrepancies.push({
            kind: "prepared_recovery",
            expected: "strict final facts",
            actual: error instanceof Error ? error.message : String(error)
          });
          return this.#stop(runId, kind, discrepancies);
        }
        classification = "completed_recovery";
      } else {
        discrepancies.push({
          kind: "integration_ref",
          expected: `${attempt.expectedOldCommit}|${attempt.candidateCommit ?? "null"}`,
          actual: actualRef
        });
        return this.#stop(runId, actualRef === null ? "missing" : "tampered", discrepancies);
      }
    } else if (actualRef !== run.integrationCommit) {
      discrepancies.push({
        kind: "integration_ref",
        expected: run.integrationCommit,
        actual: actualRef
      });
      return this.#stop(runId, actualRef === null ? "missing" : "tampered", discrepancies);
    }

    const workspaceProblem = await this.#verifyWorkspaces(run);
    if (workspaceProblem !== null) {
      return this.#stop(runId, workspaceProblem.classification, workspaceProblem.discrepancies);
    }
    const evidenceProblem = await this.#verifyEvidence(runId);
    if (evidenceProblem !== null) {
      return this.#stop(runId, evidenceProblem.classification, evidenceProblem.discrepancies);
    }
    const userChanged = await this.#userWorkspaceChanged(run);
    const result: ReconciliationResult = {
      runId,
      classification: userChanged && classification === "verified"
        ? "user_workspace_changed"
        : classification,
      discrepancies: userChanged ? [{
        kind: "original_user_worktree",
        expected: "unchanged",
        actual: "changed"
      }] : []
    };
    this.#store.insertEvent(this.#event("git.reconciliation.completed", null, {
      runId,
      classification: result.classification,
      discrepancies: result.discrepancies
    }));
    return result;
  }

  async snapshot(runId: string): Promise<GitCheckpoint> {
    const run = this.#store.getGitRun(runId);
    if (run === null || run.companyId !== this.#companyId) {
      throw new Error(`Git run not found for checkpoint: ${runId}`);
    }
    const actualRef = await this.#readRef(run);
    if (actualRef !== run.integrationCommit) {
      throw new Error(
        `cannot checkpoint: integration ref changed: expected ${run.integrationCommit}, `
        + `actual ${actualRef ?? "missing"}`
      );
    }
    const workspaceProblem = await this.#verifyWorkspaces(run);
    if (workspaceProblem !== null) {
      throw new Error(
        `cannot checkpoint: workspace facts are ${workspaceProblem.classification}: `
        + JSON.stringify(workspaceProblem.discrepancies)
      );
    }
    const evidenceProblem = await this.#verifyEvidence(runId);
    if (evidenceProblem !== null) {
      throw new Error(
        `cannot checkpoint: evidence facts are ${evidenceProblem.classification}: `
        + JSON.stringify(evidenceProblem.discrepancies)
      );
    }
    const submissions = new Map<string, number>();
    for (const record of this.#store.listGitSubmissions(runId)) {
      if (record.status === "integrated" || record.status === "superseded") continue;
      submissions.set(
        record.taskId,
        Math.max(record.revision, submissions.get(record.taskId) ?? 0)
      );
    }
    return {
      runId,
      integrationRef: run.integrationRef,
      integrationCommit: run.integrationCommit,
      workspaces: this.#store.listGitWorkspaces(runId).map((workspace) => ({
        workspaceId: workspace.workspaceId,
        branchRef: workspace.branchRef,
        headCommit: workspace.headCommit,
        status: workspace.status
      })),
      activeSubmissionRevisions: [...submissions]
        .map(([taskId, revision]) => ({ taskId, revision }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId, "en")),
      integrationAttemptIds: this.#store.listIntegrationAttempts(runId)
        .filter(({ status }) => status === "prepared")
        .map(({ attemptId }) => attemptId)
        .sort()
    };
  }

  async #readRef(run: GitRunRecord): Promise<string | null> {
    const result = await this.#git.run(
      ["show-ref", "--verify", "--hash", run.integrationRef],
      { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async #commitExists(run: GitRunRecord, commit: string): Promise<boolean> {
    const result = await this.#git.run(
      ["cat-file", "-e", `${commit}^{commit}`],
      { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
    );
    return result.exitCode === 0;
  }

  async #verifyWorkspaces(run: GitRunRecord): Promise<{
    classification: "missing" | "tampered";
    discrepancies: Discrepancy[];
  } | null> {
    const result = await this.#git.run(
      ["worktree", "list", "--porcelain"],
      { cwd: run.projectRoot }
    );
    const entries = parseWorktrees(result.stdout);
    for (const workspace of this.#store.listGitWorkspaces(run.runId)) {
      if (workspace.status === "missing") continue;
      const entry = entries.find(({ path }) => pathKey(path) === pathKey(workspace.path));
      if (entry === undefined) {
        return {
          classification: "missing",
          discrepancies: [{
            kind: `workspace:${workspace.workspaceId}`,
            expected: workspace.path,
            actual: null
          }]
        };
      }
      if (entry.branch !== workspace.branchRef || entry.head !== workspace.headCommit) {
        return {
          classification: "tampered",
          discrepancies: [{
            kind: `workspace_head:${workspace.workspaceId}`,
            expected: `${workspace.branchRef}@${workspace.headCommit}`,
            actual: `${entry.branch ?? "null"}@${entry.head ?? "null"}`
          }]
        };
      }
      const ref = await this.#git.run(
        ["show-ref", "--verify", "--hash", workspace.branchRef],
        { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
      );
      if (ref.exitCode !== 0) {
        return {
          classification: "missing",
          discrepancies: [{
            kind: `workspace_ref:${workspace.workspaceId}`,
            expected: workspace.headCommit,
            actual: null
          }]
        };
      }
      if (ref.stdout.trim() !== workspace.headCommit) {
        return {
          classification: "tampered",
          discrepancies: [{
            kind: `workspace_ref:${workspace.workspaceId}`,
            expected: workspace.headCommit,
            actual: ref.stdout.trim()
          }]
        };
      }
    }
    return null;
  }

  async #verifyEvidence(runId: string): Promise<{
    classification: "missing" | "tampered";
    discrepancies: Discrepancy[];
  } | null> {
    for (const record of this.#store.listReviewPackages(runId)) {
      if (record.status === "deleted") continue;
      try {
        await this.#evidenceBuilder.verify(record);
      } catch (error) {
        return {
          classification: missingEvidence(error) ? "missing" : "tampered",
          discrepancies: [{
            kind: `evidence:${record.taskId}:${record.revision}`,
            expected: record.manifestHash,
            actual: error instanceof Error ? error.message : String(error)
          }]
        };
      }
    }
    return null;
  }

  async #verifyOldShaCandidate(
    run: GitRunRecord,
    attempt: IntegrationAttemptRecord
  ): Promise<{
    classification: "missing" | "tampered";
    discrepancies: Discrepancy[];
  } | null> {
    const expectedWorkspaceId = `${run.runId}:candidate:${attempt.attemptId}`;
    const candidates = this.#store.listGitWorkspaces(run.runId).filter(
      ({ kind, workspaceId, branchRef, status }) => kind === "candidate"
        && (workspaceId === expectedWorkspaceId || branchRef === attempt.candidateRef)
        && status !== "missing"
    );
    if (candidates.length === 0) {
      return attempt.candidateCommit === null ? null : {
        classification: "missing",
        discrepancies: [{
          kind: `candidate:${attempt.attemptId}`,
          expected: attempt.candidateCommit,
          actual: null
        }]
      };
    }
    if (candidates.length !== 1) {
      return {
        classification: "tampered",
        discrepancies: [{
          kind: `candidate_count:${attempt.attemptId}`,
          expected: "1",
          actual: String(candidates.length)
        }]
      };
    }
    const candidate = candidates[0]!;
    const expectedPath = resolve(
      run.projectRoot,
      ".agenttown",
      "worktrees",
      run.runId,
      "candidate",
      attempt.attemptId
    );
    if (candidate.workspaceId !== expectedWorkspaceId
      || candidate.branchRef !== attempt.candidateRef
      || resolve(candidate.path) !== expectedPath
      || candidate.taskId !== null
      || candidate.employeeId !== null
      || candidate.status !== "active"
      || attempt.candidateCommit === null
      || candidate.baseCommit !== attempt.expectedOldCommit
      || candidate.headCommit !== attempt.candidateCommit) {
      return {
        classification: "tampered",
        discrepancies: [{
          kind: `candidate_facts:${attempt.attemptId}`,
          expected: `${expectedWorkspaceId}:${expectedPath}:${attempt.candidateRef}:${attempt.expectedOldCommit}@${attempt.candidateCommit ?? "null"}`,
          actual: `${candidate.workspaceId}:${resolve(candidate.path)}:${candidate.branchRef}:${candidate.baseCommit}@${candidate.headCommit}`
        }]
      };
    }
    return this.#verifyWorkspaces(run);
  }

  async #userWorkspaceChanged(run: GitRunRecord): Promise<boolean> {
    const status = await this.#git.run(
      [
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude).agenttown"
      ],
      { cwd: run.projectRoot }
    );
    const head = await this.#git.run(["rev-parse", "HEAD"], { cwd: run.projectRoot });
    const branch = await this.#git.run(
      ["symbolic-ref", "--quiet", "HEAD"],
      { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
    );
    return status.stdout.length !== 0
      || head.stdout.trim() !== run.baseCommit
      || branch.exitCode !== 0
      || branch.stdout.trim() !== `refs/heads/${run.originalBranch}`;
  }

  async #rollbackPrepared(run: GitRunRecord, attempt: IntegrationAttemptRecord): Promise<void> {
    const candidates = this.#store.listGitWorkspaces(run.runId).filter(
      (workspace) => workspace.kind === "candidate"
        && workspace.branchRef === attempt.candidateRef
        && workspace.status !== "missing"
    );
    if (candidates.length > 1) throw new Error("prepared candidate identity is not unique");
    const candidate = candidates[0];
    if (candidate !== undefined) {
      this.#store.commitGitWorkspace({
        workspace: { ...candidate, status: "completed" },
        event: this.#event("git.workspace.completed", candidate.taskId, {
          workspaceId: candidate.workspaceId,
          headCommit: candidate.headCommit
        })
      });
      await this.#workspaceManager.removeVerifiedWorkspace(candidate.workspaceId);
      const deleted = await this.#git.run(
        ["update-ref", "-d", candidate.branchRef, candidate.headCommit],
        { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
      );
      if (deleted.exitCode !== 0) throw new Error("verified candidate ref cleanup failed");
    }
    this.#store.commitIntegrationAttemptOutcome({
      attempt: { ...attempt, status: "aborted" },
      event: this.#event("git.integration.aborted", attempt.taskId, {
        attemptId: attempt.attemptId,
        reason: "reconciled_ref_at_old_commit"
      })
    });
  }

  async #completePrepared(run: GitRunRecord, attempt: IntegrationAttemptRecord): Promise<void> {
    if (attempt.candidateCommit === null) throw new Error("missing candidate commit");
    const submission = this.#store.getGitSubmission(
      run.runId,
      attempt.taskId,
      attempt.submissionRevision
    );
    const task = this.#store.getTask(this.#companyId, attempt.taskId);
    const evidence = this.#store.getReviewPackage(
      run.runId,
      attempt.taskId,
      attempt.submissionRevision
    );
    if (submission === null || submission.status !== "queued"
      || task === null || task.status !== "review" || evidence === null) {
      throw new Error("missing strict prepared recovery facts");
    }
    await this.#evidenceBuilder.verify(evidence);
    const integrations = this.#store.listGitWorkspaces(run.runId).filter(
      (workspace) => workspace.kind === "integration"
        && workspace.branchRef === run.integrationRef
        && workspace.status === "active"
    );
    const integration = integrations[0];
    if (integrations.length !== 1 || integration === undefined) {
      throw new Error("missing unique integration workspace");
    }
    await this.#git.run(
      ["checkout", "--detach", attempt.candidateCommit],
      { cwd: integration.path }
    );
    await this.#git.run(
      ["symbolic-ref", "HEAD", run.integrationRef],
      { cwd: integration.path }
    );
    const committedEvent = this.#event("git.integration.committed", attempt.taskId, {
      attemptId: attempt.attemptId,
      oldCommit: attempt.expectedOldCommit,
      newCommit: attempt.candidateCommit,
      validationRunIds: attempt.validationRunIds
    });
    const completedEvent = this.#event("task.completed", attempt.taskId, {
      attemptId: attempt.attemptId,
      runId: attempt.runId,
      revision: attempt.submissionRevision,
      integrationCommit: attempt.candidateCommit
    });
    const completedTask: TaskRecord = {
      ...task,
      status: "completed",
      updatedEventId: completedEvent.id
    };
    const completion = {
      attempt: { ...attempt, status: "committed" as const },
      submission: { ...submission, status: "integrated" as const },
      task: completedTask,
      run: {
        ...run,
        integrationCommit: attempt.candidateCommit,
        updatedAt: new Date().toISOString()
      },
      integrationWorkspace: {
        ...integration,
        headCommit: attempt.candidateCommit
      },
      events: [committedEvent, completedEvent] as const
    };
    if (submission.supersedes === null) {
      this.#store.commitIntegratedTask({
        companyId: this.#companyId,
        ...completion
      });
    } else {
      if (this.#conflictService === undefined) {
        throw new Error("strict conflict recovery service is required");
      }
      await this.#conflictService.completeResolution(completion);
    }
  }

  #stop(
    runId: string,
    classification: "missing" | "tampered",
    discrepancies: Discrepancy[]
  ): ReconciliationResult {
    discrepancies = canonicalDiscrepancies(discrepancies);
    const result: ReconciliationResult = { runId, classification, discrepancies };
    const hash = createHash("sha256")
      .update(JSON.stringify({ runId, classification, discrepancies }))
      .digest("hex");
    const baseApprovalId = `git-reconciliation-${runId}-${classification}-${hash.slice(0, 24)}`;
    let createdAt = new Date().toISOString();
    const request = {
      reason: "git_reconciliation_stop",
      runId,
      classification,
      discrepancies
    };
    let approvalId = baseApprovalId;
    for (let episode = 1; ; episode += 1) {
      const existing = this.#store.getApproval(approvalId);
      if (existing === null) break;
      if (!exactJson(existing.request, request)) {
        throw new Error("Git reconciliation approval episode identity is forged");
      }
      if (existing.status === "pending") {
        createdAt = existing.createdAt;
        break;
      }
      approvalId = `${baseApprovalId}-${episode + 1}`;
    }
    const approval: ApprovalRecord = {
      id: approvalId,
      companyId: this.#companyId,
      taskId: null,
      status: "pending",
      request,
      decision: null,
      createdAt,
      decidedAt: null
    };
    this.#store.commitGitReconciliationStop({
      companyId: this.#companyId,
      runId,
      classification,
      approval,
      event: {
        ...this.#event("git.tampering_detected", null, {
          approvalId,
          runId,
          classification,
          discrepancies
        }),
        id: `git-tampering-detected-${approvalId}`
      }
    });
    return result;
  }

  #event(type: string, taskId: string | null, payload: Record<string, unknown>): NewEvent {
    return {
      id: randomUUID(),
      type,
      actorId: "core",
      taskId,
      causationEventId: null,
      payload
    };
  }
}
