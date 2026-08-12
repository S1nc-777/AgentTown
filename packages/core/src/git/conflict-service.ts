import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  CompanyDefinition,
  GitSubmissionRecord,
  GitWorkspaceRecord,
  IntegrationAttemptRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import {
  CoreStore,
  type ApprovalRecord,
  type NewEvent
} from "../storage/core-store.js";
import { GitCommandRunner } from "./git-command.js";
import type {
  CreateTaskWorkspaceInput
} from "./workspace-manager.js";
import { candidateRef } from "./workspace-manager.js";

interface ConflictWorkspaceManager {
  createTaskWorkspace(
    input: CreateTaskWorkspaceInput
  ): Promise<GitWorkspaceRecord>;
}

interface ConflictGitRunner {
  run: GitCommandRunner["run"];
}

export interface ConflictServiceOptions {
  store: CoreStore;
  companyId: string;
  company: CompanyDefinition;
  runId: string;
  workspaceManager: ConflictWorkspaceManager;
  git?: ConflictGitRunner;
}

export interface PrepareResolutionWorkspaceInput {
  taskId: string;
  actorEmployeeId: string;
  employeeId: string;
}

export interface CompleteResolutionInput {
  attempt: IntegrationAttemptRecord;
  submission: GitSubmissionRecord;
  task: TaskRecord;
  run: NonNullable<ReturnType<CoreStore["getGitRun"]>>;
  integrationWorkspace: GitWorkspaceRecord;
  events: readonly [NewEvent, NewEvent];
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class ConflictService {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #runId: string;
  readonly #workspaceManager: ConflictWorkspaceManager;
  readonly #git: ConflictGitRunner;

  constructor(options: ConflictServiceOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#runId = options.runId;
    this.#workspaceManager = options.workspaceManager;
    this.#git = options.git ?? new GitCommandRunner();
  }

  async createTask(attemptInput: IntegrationAttemptRecord): Promise<TaskRecord> {
    const bound = await this.#bindConflictedAttempt(attemptInput);
    const taskId = `conflict-${bound.original.id}-${String(bound.submission.revision)}`;
    const existing = this.#store.getTask(this.#companyId, taskId);
    if (existing !== null) {
      this.#assertCreatedReplay(
        existing,
        bound.original,
        bound.attempt,
        bound.submission
      );
      return existing;
    }
    const linked = this.#store.listTasks(this.#companyId).filter(
      ({ conflictForTaskId }) => conflictForTaskId === bound.original.id
    );
    if (linked.length !== 0) {
      throw new Error("conflict task identity is not unique");
    }
    const completedDependencies = bound.original.dependencies.map(
      (dependencyId) => {
        const dependency = this.#store.getTask(this.#companyId, dependencyId);
        if (dependency?.status !== "completed") {
          throw new Error(
            `conflict task dependency is not completed: ${dependencyId}`
          );
        }
        return dependencyId;
      }
    );
    if (completedDependencies.includes(bound.original.id)) {
      throw new Error("conflict task dependency cycle");
    }
    const blockedEvent = this.#event("task.blocked", bound.original.id, {
      attemptId: bound.attempt.attemptId,
      runId: this.#runId,
      revision: bound.submission.revision,
      conflictTaskId: taskId,
      files: [...bound.attempt.conflictFiles]
    });
    const createdEvent = this.#event("task.created", taskId, {
      attemptId: bound.attempt.attemptId,
      runId: this.#runId,
      originalTaskId: bound.original.id,
      originalRevision: bound.submission.revision,
      files: [...bound.attempt.conflictFiles]
    });
    const blocked: TaskRecord = {
      ...bound.original,
      status: "blocked",
      updatedEventId: blockedEvent.id
    };
    const conflict: TaskRecord = {
      id: taskId,
      title: `Resolve integration conflict for ${bound.original.title}`,
      objective: [
        `Resolve the reviewed integration conflict for ${bound.original.id}.`,
        `Conflict files: ${bound.attempt.conflictFiles.join(", ")}`
      ].join(" "),
      ownerEmployeeId: null,
      dependencies: completedDependencies,
      acceptanceCriteria: [
        ...bound.original.acceptanceCriteria,
        "Resolve only the recorded integration conflict scope"
      ],
      status: "draft",
      retryCount: 0,
      reviewLoopCount: 0,
      artifacts: bound.attempt.conflictFiles.map(
        (path) => `conflict-file:${path}`
      ),
      evidence: [
        `integration-attempt:${bound.attempt.attemptId}`,
        `submission-revision:${String(bound.submission.revision)}`
      ],
      conflictForTaskId: bound.original.id,
      createdEventId: createdEvent.id,
      updatedEventId: createdEvent.id
    };
    this.#store.commitConflictTaskCreation({
      companyId: this.#companyId,
      attempt: bound.attempt,
      submission: bound.submission,
      originalTask: blocked,
      conflictTask: conflict,
      events: [blockedEvent, createdEvent]
    });
    return conflict;
  }

  async prepareResolutionWorkspace(
    input: PrepareResolutionWorkspaceInput
  ): Promise<GitWorkspaceRecord> {
    const leaders = this.#company.employees.filter(
      ({ reportsTo, workspace }) =>
        reportsTo === "owner" && workspace === "read_only"
    );
    if (leaders.length !== 1 || input.actorEmployeeId !== leaders[0]?.id) {
      throw new Error("leader permission required");
    }
    const employee = this.#company.employees.find(
      ({ id }) => id === input.employeeId
    );
    if (employee === undefined) {
      throw new Error(`unknown employee: ${input.employeeId}`);
    }
    if (employee.workspace !== "git_worktree") {
      throw new Error(
        `employee requires git_worktree workspace: ${input.employeeId}`
      );
    }
    const bound = await this.#bindResolutionTask(input.taskId);
    const existing = this.#store.listGitWorkspaces(this.#runId).filter(
      (workspace) => workspace.kind === "task"
        && workspace.taskId === bound.conflict.id
        && workspace.status === "active"
    );
    if (existing.length > 1
      || existing[0] !== undefined
        && existing[0].employeeId !== input.employeeId) {
      throw new Error("resolution workspace binding is not unique");
    }
    if (existing[0] !== undefined) {
      await this.#assertPreparedWorkspace(
        existing[0],
        input.employeeId,
        bound
      );
      return existing[0];
    }

    const workspace = await this.#workspaceManager.createTaskWorkspace({
      runId: this.#runId,
      employeeId: input.employeeId,
      taskId: bound.conflict.id,
      baseCommit: bound.run.integrationCommit
    });
    const durable = this.#store.getGitWorkspace(workspace.workspaceId);
    if (durable === null
      || !sameJson(durable, workspace)
      || workspace.runId !== this.#runId
      || workspace.taskId !== bound.conflict.id
      || workspace.employeeId !== input.employeeId
      || workspace.kind !== "task"
      || workspace.status !== "active"
      || workspace.baseCommit !== bound.run.integrationCommit
      || workspace.headCommit !== bound.run.integrationCommit) {
      throw new Error("created resolution workspace is stale or mismatched");
    }

    const picked = await this.#git.run(
      [
        "cherry-pick",
        "--no-commit",
        ...bound.submission.submission.commits
      ],
      {
        cwd: workspace.path,
        allowedExitCodes: [0, 1],
        gitEditor: true
      }
    );
    const actualFiles = await this.#conflictFiles(workspace.path);
    if (picked.exitCode === 0
      || !sameJson(actualFiles, bound.attempt.conflictFiles)) {
      this.#requestScopeReview(
        bound.conflict,
        bound.attempt,
        bound.attempt.conflictFiles,
        actualFiles
      );
      throw new Error("conflict scope changed; user review required");
    }
    await this.#assertPreparedWorkspace(
      workspace,
      input.employeeId,
      bound
    );
    return workspace;
  }

  async supersessionFor(
    taskId: string
  ): Promise<NonNullable<GitSubmissionRecord["supersedes"]>> {
    const bound = await this.#bindResolutionTask(taskId);
    return {
      taskId: bound.original.id,
      revision: bound.submission.revision,
      attemptId: bound.attempt.attemptId
    };
  }

  async recordResolutionConflict(
    attemptInput: IntegrationAttemptRecord
  ): Promise<void> {
    const bound = await this.#bindResolutionTask(attemptInput.taskId);
    const run = this.#store.getGitRun(this.#runId);
    const attempt = this.#store.getIntegrationAttempt(attemptInput.attemptId);
    const matchingAttempts = this.#store.listIntegrationAttempts(
      this.#runId,
      attemptInput.taskId
    ).filter(({ submissionRevision }) =>
      submissionRevision === attemptInput.submissionRevision
    );
    const resolutionSubmission = this.#store.getGitSubmission(
      this.#runId,
      attemptInput.taskId,
      attemptInput.submissionRevision
    );
    const latestResolution = this.#store.listGitSubmissions(
      this.#runId,
      attemptInput.taskId
    ).at(-1);
    const candidate = this.#store.getGitWorkspace(
      `${this.#runId}:candidate:${attemptInput.attemptId}`
    );
    const expectedSupersedes = {
      taskId: bound.original.id,
      revision: bound.submission.revision,
      attemptId: bound.attempt.attemptId
    };
    if (run === null
      || run.companyId !== this.#companyId
      || run.status !== "active"
      || attemptInput.runId !== this.#runId
      || attemptInput.expectedOldCommit !== run.integrationCommit
      || attemptInput.candidateRef
        !== candidateRef(this.#runId, attemptInput.attemptId)
      || matchingAttempts.length !== 1
      || attempt === null
      || !sameJson(attempt, attemptInput)
      || attempt.status !== "conflicted"
      || attempt.conflictFiles.length === 0
      || resolutionSubmission === null
      || resolutionSubmission.status !== "queued"
      || latestResolution === undefined
      || latestResolution.revision !== resolutionSubmission.revision
      || !sameJson(resolutionSubmission.supersedes, expectedSupersedes)) {
      throw new Error("resolution integration conflict facts are stale");
    }
    if (candidate === null
      || candidate.runId !== this.#runId
      || candidate.workspaceId
        !== `${this.#runId}:candidate:${attempt.attemptId}`
      || candidate.kind !== "candidate"
      || candidate.taskId !== null
      || candidate.employeeId !== null
      || candidate.status !== "missing"
      || candidate.branchRef !== attempt.candidateRef
      || candidate.baseCommit !== attempt.expectedOldCommit
      || candidate.headCommit !== attempt.expectedOldCommit
      || await this.#readRef(run.projectRoot, attempt.candidateRef) !== null) {
      throw new Error("resolution conflict candidate cleanup is stale");
    }
    const approvalId = [
      "resolution-conflict",
      this.#companyId,
      this.#runId,
      bound.conflict.id,
      String(resolutionSubmission.revision)
    ].join(":");
    const request = {
      reason: "resolution_integration_conflicted",
      runId: this.#runId,
      taskId: bound.conflict.id,
      originalTaskId: bound.original.id,
      attemptId: attempt.attemptId,
      expectedFiles: [...bound.attempt.conflictFiles],
      actualFiles: [...attempt.conflictFiles],
      operation: `review repeated resolution conflict for ${bound.conflict.id}`,
      impact: "The reviewed resolution conflicted during final integration.",
      alternatives: ["review_changed_scope", "stop_task"],
      consequenceOfNonApproval: "The resolution remains queued and blocked from retry.",
      question: "Should the repeated resolution conflict be reviewed?",
      options: ["review_changed_scope", "stop_task"]
    };
    const existing = this.#store.getApproval(approvalId);
    if (existing !== null) {
      const approvalEvents = this.#store.listEvents(0).filter((event) =>
        event.type === "user.approval.requested"
        && event.payload.approvalId === approvalId
      );
      const approvalEvent = approvalEvents[0];
      if (existing.companyId !== this.#companyId
        || existing.taskId !== bound.conflict.id
        || existing.status !== "pending"
        || existing.decision !== null
        || existing.decidedAt !== null
        || !sameJson(existing.request, request)
        || approvalEvents.length !== 1
        || approvalEvent?.actorId !== "core"
        || approvalEvent.taskId !== bound.conflict.id
        || approvalEvent.causationEventId !== null
        || !sameJson(approvalEvent.payload, {
          approvalId,
          ...request
        })) {
        throw new Error("resolution conflict approval replay is stale");
      }
      return;
    }
    const createdAt = new Date().toISOString();
    const approval: ApprovalRecord = {
      id: approvalId,
      companyId: this.#companyId,
      taskId: bound.conflict.id,
      status: "pending",
      request,
      decision: null,
      createdAt,
      decidedAt: null
    };
    this.#store.commitApprovalRequest({
      approval,
      event: this.#event("user.approval.requested", bound.conflict.id, {
        approvalId: approval.id,
        ...approval.request
      })
    });
  }

  async completeResolution(input: CompleteResolutionInput): Promise<void> {
    // The integration ref and formal worktree have already advanced under CAS
    // when this final durable commit is invoked. Re-bind the immutable Core
    // evidence without requiring the pre-CAS Git state a second time.
    const bound = await this.#bindResolutionTask(input.task.id, false);
    const expected = {
      taskId: bound.original.id,
      revision: bound.submission.revision,
      attemptId: bound.attempt.attemptId
    };
    if (input.submission.supersedes === null
      || !sameJson(input.submission.supersedes, expected)
      || input.attempt.taskId !== input.task.id
      || input.attempt.submissionRevision !== input.submission.revision) {
      throw new Error("resolution supersession facts are stale or mismatched");
    }
    const originalAttempt = this.#store.getIntegrationAttempt(
      expected.attemptId
    );
    const originalSubmission = this.#store.getGitSubmission(
      this.#runId,
      expected.taskId,
      expected.revision
    );
    const original = this.#store.getTask(this.#companyId, expected.taskId);
    if (originalAttempt === null
      || originalAttempt.status !== "conflicted"
      || originalSubmission === null
      || originalSubmission.status !== "queued"
      || originalSubmission.supersedes !== null
      || original === null
      || original.status !== "blocked") {
      throw new Error("superseded original conflict facts are stale");
    }
    const originalCompletedEvent = this.#event(
      "task.completed",
      original.id,
      {
        resolutionTaskId: input.task.id,
        resolutionAttemptId: input.attempt.attemptId,
        supersededAttemptId: originalAttempt.attemptId,
        revision: originalSubmission.revision,
        integrationCommit: input.attempt.candidateCommit
      }
    );
    this.#store.commitResolvedConflict({
      companyId: this.#companyId,
      attempt: input.attempt,
      submission: input.submission,
      conflictTask: input.task,
      originalAttempt,
      originalSubmission: {
        ...originalSubmission,
        status: "superseded"
      },
      originalTask: {
        ...original,
        status: "completed",
        updatedEventId: originalCompletedEvent.id
      },
      run: input.run,
      integrationWorkspace: input.integrationWorkspace,
      events: [
        input.events[0],
        input.events[1],
        originalCompletedEvent
      ]
    });
  }

  async #bindResolutionTask(taskId: string, assertGitState = true): Promise<{
    attempt: IntegrationAttemptRecord;
    conflict: TaskRecord;
    original: TaskRecord;
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>;
    submission: GitSubmissionRecord;
  }> {
    const conflict = this.#store.getTask(this.#companyId, taskId);
    if (conflict === null
      || conflict.conflictForTaskId === null
      || !["draft", "ready", "running", "review"].includes(conflict.status)
      || (conflict.status === "draft" && conflict.ownerEmployeeId !== null)) {
      throw new Error("resolution conflict task is stale or mismatched");
    }
    const created = this.#store.listEvents(0).find(
      ({ id }) => id === conflict.createdEventId
    );
    const attemptId = created?.payload.attemptId;
    const originalRevision = created?.payload.originalRevision;
    const files = created?.payload.files;
    if (created?.type !== "task.created"
      || created.actorId !== "core"
      || created.taskId !== conflict.id
      || created.causationEventId !== null
      || typeof attemptId !== "string"
      || !Number.isSafeInteger(originalRevision)
      || !Array.isArray(files)
      || files.some((file) => typeof file !== "string")) {
      throw new Error("resolution conflict creation evidence is invalid");
    }
    const attempt = this.#store.getIntegrationAttempt(attemptId);
    if (attempt === null
      || attempt.taskId !== conflict.conflictForTaskId
      || attempt.submissionRevision !== originalRevision
      || !sameJson(attempt.conflictFiles, files)) {
      throw new Error("resolution conflict attempt evidence is stale");
    }
    const bound = await this.#bindConflictedAttempt(attempt, assertGitState);
    const run = this.#store.getGitRun(this.#runId);
    if (run === null
      || bound.original.status !== "blocked"
      || conflict.dependencies.includes(bound.original.id)
      || !sameJson(
        conflict.dependencies,
        bound.original.dependencies.filter(
          (dependencyId) =>
            this.#store.getTask(this.#companyId, dependencyId)?.status
              === "completed"
        )
      )) {
      throw new Error("resolution task dependency or original binding is stale");
    }
    return {
      attempt: bound.attempt,
      conflict,
      original: bound.original,
      run,
      submission: bound.submission
    };
  }

  async #assertPreparedWorkspace(
    workspace: GitWorkspaceRecord,
    employeeId: string,
    bound: {
      attempt: IntegrationAttemptRecord;
      conflict: TaskRecord;
      run: NonNullable<ReturnType<CoreStore["getGitRun"]>>;
      submission: GitSubmissionRecord;
    }
  ): Promise<void> {
    const durable = this.#store.getGitWorkspace(workspace.workspaceId);
    const head = await this.#git.run(
      ["rev-parse", "HEAD"],
      { cwd: workspace.path }
    );
    const ref = await this.#git.run(
      ["symbolic-ref", "HEAD"],
      { cwd: workspace.path }
    );
    const branchHead = await this.#readRef(
      bound.run.projectRoot,
      workspace.branchRef
    );
    const files = await this.#conflictFiles(workspace.path);
    if (durable === null
      || !sameJson(durable, workspace)
      || workspace.runId !== this.#runId
      || workspace.taskId !== bound.conflict.id
      || workspace.employeeId !== employeeId
      || workspace.kind !== "task"
      || workspace.status !== "active"
      || workspace.baseCommit !== bound.run.integrationCommit
      || workspace.headCommit !== bound.run.integrationCommit
      || head.stdout.trim() !== bound.run.integrationCommit
      || ref.stdout.trim() !== workspace.branchRef
      || branchHead !== bound.run.integrationCommit
      || !sameJson(files, bound.attempt.conflictFiles)) {
      throw new Error("prepared resolution workspace is stale or mismatched");
    }
  }

  async #conflictFiles(workspacePath: string): Promise<string[]> {
    const status = await this.#git.run(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      { cwd: workspacePath }
    );
    return status.stdout.split("\0").flatMap((entry) => {
      const match = /^u (?:\S+ ){9}([\s\S]+)$/u.exec(entry);
      return match?.[1] === undefined ? [] : [match[1]];
    }).sort();
  }

  #requestScopeReview(
    conflict: TaskRecord,
    attempt: IntegrationAttemptRecord,
    expectedFiles: readonly string[],
    actualFiles: readonly string[]
  ): void {
    const createdAt = new Date().toISOString();
    const approval: ApprovalRecord = {
      id: [
        "conflict-scope",
        this.#companyId,
        this.#runId,
        conflict.id
      ].join(":"),
      companyId: this.#companyId,
      taskId: conflict.id,
      status: "pending",
      request: {
        reason: "conflict_scope_changed",
        runId: this.#runId,
        taskId: conflict.id,
        originalTaskId: attempt.taskId,
        attemptId: attempt.attemptId,
        expectedFiles: [...expectedFiles],
        actualFiles: [...actualFiles],
        operation: `prepare resolution workspace for ${conflict.id}`,
        impact: "The reviewed conflict could not be reproduced exactly.",
        alternatives: ["review_changed_scope", "stop_task"],
        consequenceOfNonApproval: "The conflict task remains unassigned.",
        question: "Should the changed conflict scope be reviewed?",
        options: ["review_changed_scope", "stop_task"]
      },
      decision: null,
      createdAt,
      decidedAt: null
    };
    this.#store.commitApprovalRequest({
      approval,
      event: this.#event("user.approval.requested", conflict.id, {
        approvalId: approval.id,
        ...approval.request
      })
    });
  }

  async #bindConflictedAttempt(
    attemptInput: IntegrationAttemptRecord,
    assertGitState = true
  ): Promise<{
    attempt: IntegrationAttemptRecord;
    original: TaskRecord;
    submission: GitSubmissionRecord;
  }> {
    const company = this.#store.getCompany(this.#companyId);
    const run = this.#store.getGitRun(this.#runId);
    const attempt = this.#store.getIntegrationAttempt(attemptInput.attemptId);
    if (company === null
      || company.definitionJson !== JSON.stringify(this.#company)
      || run === null
      || run.companyId !== this.#companyId
      || run.status !== "active"
      || attempt === null
      || !sameJson(attempt, attemptInput)
      || attempt.runId !== this.#runId
      || attempt.status !== "conflicted"
      || attempt.candidateCommit !== null
      || attempt.conflictFiles.length === 0
      || new Set(attempt.conflictFiles).size !== attempt.conflictFiles.length
      || [...attempt.conflictFiles].sort().some(
        (path, index) => path !== attempt.conflictFiles[index]
      )) {
      throw new Error("conflicted integration attempt is stale or mismatched");
    }
    const original = this.#store.getTask(this.#companyId, attempt.taskId);
    const submission = this.#store.getGitSubmission(
      this.#runId,
      attempt.taskId,
      attempt.submissionRevision
    );
    const latest = this.#store
      .listGitSubmissions(this.#runId, attempt.taskId)
      .at(-1);
    const decision = this.#store.getReviewDecision(
      this.#runId,
      attempt.taskId,
      attempt.submissionRevision
    );
    const reviewPackage = this.#store.getReviewPackage(
      this.#runId,
      attempt.taskId,
      attempt.submissionRevision
    );
    if (original === null
      || (original.status !== "review" && original.status !== "blocked")
      || original.conflictForTaskId !== null
      || submission === null
      || submission.status !== "queued"
      || submission.supersedes !== null
      || latest?.revision !== submission.revision
      || decision?.decision !== "approve"
      || reviewPackage === null
      || reviewPackage.status === "tampered"
      || reviewPackage.status === "deleted"
      || reviewPackage.manifestHash !== decision.reviewedManifestHash) {
      throw new Error("conflict original task or reviewed submission is stale");
    }
    if (assertGitState) await this.#assertGitState(run, attempt);
    return { attempt, original, submission };
  }

  async #assertGitState(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    attempt: IntegrationAttemptRecord
  ): Promise<void> {
    const integration = this.#store.listGitWorkspaces(this.#runId).filter(
      (workspace) => workspace.kind === "integration"
        && workspace.taskId === null
        && workspace.employeeId === null
        && workspace.status === "active"
        && workspace.branchRef === run.integrationRef
    );
    const candidate = this.#store.getGitWorkspace(
      `${this.#runId}:candidate:${attempt.attemptId}`
    );
    if (integration.length !== 1
      || integration[0]?.workspaceId !== `${this.#runId}:integration`
      || integration[0]?.headCommit !== run.integrationCommit
      || candidate === null
      || candidate.runId !== this.#runId
      || candidate.kind !== "candidate"
      || candidate.taskId !== null
      || candidate.employeeId !== null
      || candidate.status !== "missing"
      || candidate.branchRef !== attempt.candidateRef
      || candidate.baseCommit !== attempt.expectedOldCommit
      || candidate.headCommit !== attempt.expectedOldCommit) {
      throw new Error("conflict workspace cleanup facts are stale or mismatched");
    }
    const formal = integration[0]!;
    const ref = await this.#readRef(run.projectRoot, run.integrationRef);
    const candidateRef = await this.#readRef(
      run.projectRoot,
      attempt.candidateRef
    );
    const top = await this.#git.run(
      ["rev-parse", "--show-toplevel"],
      { cwd: formal.path }
    );
    const head = await this.#git.run(
      ["rev-parse", "HEAD"],
      { cwd: formal.path }
    );
    const symbolic = await this.#git.run(
      ["symbolic-ref", "HEAD"],
      { cwd: formal.path }
    );
    const status = await this.#git.run(
      ["status", "--porcelain=v2", "--untracked-files=all"],
      { cwd: formal.path }
    );
    if (ref !== run.integrationCommit
      || candidateRef !== null
      || pathKey(top.stdout.trim()) !== pathKey(formal.path)
      || head.stdout.trim() !== run.integrationCommit
      || symbolic.stdout.trim() !== run.integrationRef
      || status.stdout.length !== 0) {
      throw new Error("formal integration or candidate Git state changed");
    }
  }

  #assertCreatedReplay(
    conflict: TaskRecord,
    original: TaskRecord,
    attempt: IntegrationAttemptRecord,
    submission: GitSubmissionRecord
  ): void {
    const linked = this.#store.listTasks(this.#companyId).filter(
      ({ conflictForTaskId }) => conflictForTaskId === original.id
    );
    const events = this.#store.listEvents(0);
    const created = events.find(({ id }) => id === conflict.createdEventId);
    const blocked = events.find(({ id }) => id === original.updatedEventId);
    if (original.status !== "blocked"
      || linked.length !== 1
      || linked[0]?.id !== conflict.id
      || conflict.ownerEmployeeId !== null
      || conflict.status !== "draft"
      || conflict.conflictForTaskId !== original.id
      || conflict.dependencies.includes(original.id)
      || created?.type !== "task.created"
      || created.actorId !== "core"
      || created.taskId !== conflict.id
      || !sameJson(created.payload, {
        attemptId: attempt.attemptId,
        runId: this.#runId,
        originalTaskId: original.id,
        originalRevision: submission.revision,
        files: attempt.conflictFiles
      })
      || blocked?.type !== "task.blocked"
      || blocked.actorId !== "core"
      || blocked.taskId !== original.id
      || !sameJson(blocked.payload, {
        attemptId: attempt.attemptId,
        runId: this.#runId,
        revision: submission.revision,
        conflictTaskId: conflict.id,
        files: attempt.conflictFiles
      })) {
      throw new Error("durable conflict task replay facts are stale or mismatched");
    }
  }

  async #readRef(projectRoot: string, ref: string): Promise<string | null> {
    const result = await this.#git.run(
      ["rev-parse", "--verify", "--quiet", ref],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (result.exitCode === 1) return null;
    const value = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(value)) {
      throw new Error("Git returned an invalid ref object id");
    }
    return value;
  }

  #event(
    type: string,
    taskId: string,
    payload: Record<string, unknown>
  ): NewEvent {
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
