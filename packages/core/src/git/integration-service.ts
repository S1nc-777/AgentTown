import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  CompanyDefinition,
  GitRunRecord,
  GitSubmissionRecord,
  GitWorkspaceRecord,
  IntegrationAttemptRecord,
  TaskRecord,
  ValidationCommand,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../storage/core-store.js";
import { GitCommandRunner } from "./git-command.js";
import type {
  CreateCandidateWorkspaceInput
} from "./workspace-manager.js";
import { candidateRef } from "./workspace-manager.js";

export interface OrderedIntegration {
  taskId: string;
  layer: number;
  createdSequence: number;
}

interface CandidateWorkspaceManager {
  createCandidateWorkspace(
    input: CreateCandidateWorkspaceInput
  ): Promise<GitWorkspaceRecord>;
  removeVerifiedWorkspace(workspaceId: string): Promise<void>;
}

interface IntegrationValidationRunner {
  run(
    command: ValidationCommand,
    scope: {
      runId: string;
      taskId: string;
      integrationAttemptId: string;
      workspaceId: string;
      workspaceRoot: string;
    }
  ): Promise<ValidationRunRecord>;
}

interface IntegrationGitRunner {
  run: GitCommandRunner["run"];
}

export interface IntegrationFaultHooks {
  afterPrepared?(): void;
  afterRefUpdated?(): void;
  beforeFactsCommitted?(): void;
}

export interface IntegrationServiceOptions {
  store: CoreStore;
  companyId: string;
  company: CompanyDefinition;
  runId: string;
  workspaceManager: CandidateWorkspaceManager;
  validationRunner: IntegrationValidationRunner;
  faultHooks?: IntegrationFaultHooks;
  git?: IntegrationGitRunner;
}

export type IntegrationResult =
  | { kind: "integrated"; attempt: IntegrationAttemptRecord }
  | {
      kind: "conflicted";
      attempt: IntegrationAttemptRecord;
      files: string[];
    }
  | { kind: "validation_failed"; attempt: IntegrationAttemptRecord }
  | { kind: "waiting"; taskId: string }
  | { kind: "reconciliation_required"; attemptId: string };

interface OrderedTask extends OrderedIntegration {
  task: TaskRecord;
}

export function orderIntegrations<T extends OrderedIntegration>(
  candidates: readonly T[]
): T[] {
  return [...candidates].sort((left, right) =>
    left.layer - right.layer
    || left.createdSequence - right.createdSequence
    || left.taskId.localeCompare(right.taskId)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCommand(left: ValidationCommand, right: ValidationCommand): boolean {
  return left.id === right.id
    && left.executable === right.executable
    && left.cwd === right.cwd
    && left.timeoutSeconds === right.timeoutSeconds
    && left.args.length === right.args.length
    && left.args.every((argument, index) => argument === right.args[index]);
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class IntegrationService {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #runId: string;
  readonly #workspaceManager: CandidateWorkspaceManager;
  readonly #validationRunner: IntegrationValidationRunner;
  readonly #faultHooks: IntegrationFaultHooks;
  readonly #git: IntegrationGitRunner;

  constructor(options: IntegrationServiceOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#runId = options.runId;
    this.#workspaceManager = options.workspaceManager;
    this.#validationRunner = options.validationRunner;
    this.#faultHooks = options.faultHooks ?? {};
    this.#git = options.git ?? new GitCommandRunner();
  }

  async enqueue(submission: GitSubmissionRecord): Promise<void> {
    const bound = this.#bindApprovedSubmission(submission);
    this.#store.commitQueuedIntegration({
      companyId: this.#companyId,
      submission: {
        ...bound.submission,
        status: "queued"
      },
      event: this.#event("integration.queued", bound.task.id, {
        runId: this.#runId,
        revision: bound.submission.revision
      })
    });
  }

  async drain(): Promise<IntegrationResult | null> {
    this.#bindRun();
    const ordered = this.#orderedTasks();
    for (const candidate of ordered) {
      const submission = this.#store
        .listGitSubmissions(this.#runId, candidate.taskId)
        .at(-1);
      if (submission?.status !== "queued") continue;
      if (candidate.task.dependencies.some((dependencyId) =>
        this.#store.getTask(this.#companyId, dependencyId)?.status !== "completed"
      )) {
        return { kind: "waiting", taskId: candidate.taskId };
      }
      const blocker = ordered.find((other) =>
        other.layer === candidate.layer
        && this.#compareOrdered(other, candidate) < 0
        && !this.#isIntegrated(other.task)
      );
      if (blocker !== undefined) {
        return { kind: "waiting", taskId: blocker.taskId };
      }
      return await this.integrate(submission);
    }
    return null;
  }

  async integrate(submission: GitSubmissionRecord): Promise<IntegrationResult> {
    await this.enqueue(submission);
    const bound = this.#bindApprovedSubmission(submission);
    const selected = this.#select(bound.submission);
    if (selected.kind === "waiting") return selected;
    const run = this.#bindRun();
    const integrationWorkspace = await this.#integrationWorkspace(
      run,
      run.integrationCommit
    );
    const actualOldCommit = await this.#readRef(
      run.projectRoot,
      run.integrationRef
    );
    if (actualOldCommit !== run.integrationCommit) {
      throw new Error("formal integration ref does not match durable run progress");
    }
    const attemptId = `attempt-${randomUUID()}`;
    const attemptRef = candidateRef(this.#runId, attemptId);
    const prepared: IntegrationAttemptRecord = {
      attemptId,
      runId: this.#runId,
      taskId: bound.task.id,
      submissionRevision: bound.submission.revision,
      orderKey: this.#orderKey(selected.task),
      expectedOldCommit: actualOldCommit,
      candidateRef: attemptRef,
      candidateCommit: null,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    this.#store.commitPreparedIntegration({
      companyId: this.#companyId,
      attempt: prepared,
      submission: {
        ...bound.submission,
        status: "queued"
      },
      event: this.#event("git.integration.prepared", bound.task.id, {
        attemptId,
        runId: this.#runId,
        revision: bound.submission.revision,
        orderKey: prepared.orderKey,
        expectedOldCommit: actualOldCommit,
        candidateRef: attemptRef
      })
    });
    this.#faultHooks.afterPrepared?.();

    const candidate = await this.#workspaceManager.createCandidateWorkspace({
      runId: this.#runId,
      attemptId,
      baseCommit: actualOldCommit
    });
    await this.#assertCandidateWorkspace(candidate, prepared, actualOldCommit);

    for (const commit of bound.submission.submission.commits) {
      const picked = await this.#git.run(
        ["cherry-pick", commit],
        {
          cwd: candidate.path,
          allowedExitCodes: [0, 1],
          gitEditor: true
        }
      );
      if (picked.exitCode === 0) continue;
      const files = await this.#conflictFiles(candidate.path);
      if (files.length === 0) {
        throw new Error("candidate cherry-pick failed without Git conflicts");
      }
      await this.#git.run(
        ["cherry-pick", "--abort"],
        { cwd: candidate.path, gitEditor: true }
      );
      await this.#assertCandidateWorkspace(candidate, prepared, actualOldCommit);
      const conflicted: IntegrationAttemptRecord = {
        ...prepared,
        status: "conflicted",
        conflictFiles: files
      };
      this.#store.commitIntegrationAttemptOutcome({
        attempt: conflicted,
        event: this.#event("git.integration.conflicted", bound.task.id, {
          attemptId,
          files
        })
      });
      try {
        await this.#cleanupCandidate(candidate, actualOldCommit);
      } catch {
        return { kind: "reconciliation_required", attemptId };
      }
      return { kind: "conflicted", attempt: conflicted, files };
    }

    const candidateCommit = await this.#head(candidate.path);
    const advancedCandidate: GitWorkspaceRecord = {
      ...candidate,
      headCommit: candidateCommit
    };
    this.#store.commitGitWorkspace({
      workspace: advancedCandidate,
      event: this.#event("git.workspace.advanced", bound.task.id, {
        attemptId,
        workspaceId: candidate.workspaceId,
        headCommit: candidateCommit
      })
    });
    await this.#assertCandidateWorkspace(
      advancedCandidate,
      prepared,
      candidateCommit
    );
    const preparedWithCandidate: IntegrationAttemptRecord = {
      ...prepared,
      candidateCommit
    };
    this.#store.putIntegrationAttempt(preparedWithCandidate);

    const validationRunIds: string[] = [];
    let validationsPassed = true;
    for (const command of this.#integrationCommands()) {
      const record = await this.#validationRunner.run(command, {
        runId: this.#runId,
        taskId: bound.task.id,
        integrationAttemptId: attemptId,
        workspaceId: candidate.workspaceId,
        workspaceRoot: candidate.path
      });
      const durable = this.#store.getValidationRun(record.validationId);
      if (record.runId !== this.#runId
        || record.taskId !== bound.task.id
        || record.integrationAttemptId !== attemptId
        || record.workspaceId !== candidate.workspaceId
        || !sameCommand(record.command, command)
        || durable === null
        || !sameJson(durable, record)) {
        throw new Error("integration validation result is not durably and exactly bound");
      }
      validationRunIds.push(record.validationId);
      if (record.outcome !== "passed") validationsPassed = false;
    }
    const validatedPrepared: IntegrationAttemptRecord = {
      ...preparedWithCandidate,
      validationRunIds
    };
    this.#store.putIntegrationAttempt(validatedPrepared);
    if (!validationsPassed) {
      const failed: IntegrationAttemptRecord = {
        ...validatedPrepared,
        status: "validation_failed"
      };
      this.#store.commitIntegrationAttemptOutcome({
        attempt: failed,
        event: this.#event("git.integration.validation_failed", bound.task.id, {
          attemptId,
          validationRunIds
        })
      });
      try {
        await this.#cleanupCandidate(advancedCandidate, candidateCommit);
      } catch {
        return { kind: "reconciliation_required", attemptId };
      }
      return { kind: "validation_failed", attempt: failed };
    }

    if (await this.#readRef(run.projectRoot, run.integrationRef)
      !== actualOldCommit) {
      return { kind: "reconciliation_required", attemptId };
    }
    await this.#integrationWorkspace(run, actualOldCommit);
    await this.#git.run(
      ["checkout", "--detach", actualOldCommit],
      { cwd: integrationWorkspace.path }
    );
    const updated = await this.#git.run(
      [
        "update-ref",
        run.integrationRef,
        candidateCommit,
        actualOldCommit
      ],
      {
        cwd: run.projectRoot,
        allowedExitCodes: [0, 1, 128]
      }
    );
    if (updated.exitCode !== 0) {
      return { kind: "reconciliation_required", attemptId };
    }
    this.#faultHooks.afterRefUpdated?.();

    try {
      await this.#git.run(
        ["checkout", "--detach", candidateCommit],
        { cwd: integrationWorkspace.path }
      );
      await this.#git.run(
        ["symbolic-ref", "HEAD", run.integrationRef],
        { cwd: integrationWorkspace.path }
      );
    } catch {
      return { kind: "reconciliation_required", attemptId };
    }
    const advancedIntegration: GitWorkspaceRecord = {
      ...integrationWorkspace,
      headCommit: candidateCommit
    };
    await this.#assertWorkspaceGit(
      run,
      advancedIntegration,
      candidateCommit
    );
    this.#faultHooks.beforeFactsCommitted?.();

    const committedEvent = this.#event(
      "git.integration.committed",
      bound.task.id,
      {
        attemptId,
        oldCommit: actualOldCommit,
        newCommit: candidateCommit,
        validationRunIds
      }
    );
    const completedEvent = this.#event("task.completed", bound.task.id, {
      attemptId,
      runId: this.#runId,
      revision: bound.submission.revision,
      integrationCommit: candidateCommit
    });
    const committed: IntegrationAttemptRecord = {
      ...validatedPrepared,
      status: "committed"
    };
    const advancedRun: GitRunRecord = {
      ...run,
      integrationCommit: candidateCommit,
      updatedAt: new Date().toISOString()
    };
    const completedTask: TaskRecord = {
      ...bound.task,
      status: "completed",
      updatedEventId: completedEvent.id
    };
    try {
      this.#store.commitIntegratedTask({
        companyId: this.#companyId,
        attempt: committed,
        submission: {
          ...bound.submission,
          status: "integrated"
        },
        task: completedTask,
        run: advancedRun,
        integrationWorkspace: advancedIntegration,
        events: [committedEvent, completedEvent]
      });
    } catch {
      return { kind: "reconciliation_required", attemptId };
    }
    try {
      await this.#cleanupCandidate(advancedCandidate, candidateCommit);
    } catch {
      return { kind: "reconciliation_required", attemptId };
    }
    return { kind: "integrated", attempt: committed };
  }

  recoverPrepared(): IntegrationResult[] {
    this.#bindRun();
    return this.#store.listIntegrationAttempts(this.#runId)
      .filter(({ status }) => status === "prepared")
      .map(({ attemptId }) => ({
        kind: "reconciliation_required" as const,
        attemptId
      }));
  }

  #bindRun() {
    const company = this.#store.getCompany(this.#companyId);
    const run = this.#store.getGitRun(this.#runId);
    if (company === null
      || company.definitionJson !== JSON.stringify(this.#company)
      || run === null
      || run.companyId !== this.#companyId
      || run.status !== "active") {
      throw new Error("integration company or run binding is not active");
    }
    return run;
  }

  #bindApprovedSubmission(
    submission: GitSubmissionRecord
  ): { submission: GitSubmissionRecord; task: TaskRecord } {
    this.#bindRun();
    if (submission.runId !== this.#runId
      || (submission.status !== "approved" && submission.status !== "queued")) {
      throw new Error("integration submission is not approved for this run");
    }
    const task = this.#store.getTask(this.#companyId, submission.taskId);
    const latest = this.#store
      .listGitSubmissions(this.#runId, submission.taskId)
      .at(-1);
    const decision = this.#store.getReviewDecision(
      this.#runId,
      submission.taskId,
      submission.revision
    );
    const reviewPackage = this.#store.getReviewPackage(
      this.#runId,
      submission.taskId,
      submission.revision
    );
    if (task === null
      || task.status !== "review"
      || latest === undefined
      || latest.revision !== submission.revision
      || latest.runId !== submission.runId
      || latest.taskId !== submission.taskId
      || JSON.stringify(latest.submission)
        !== JSON.stringify(submission.submission)
      || (latest.status !== "approved" && latest.status !== "queued")
      || decision?.decision !== "approve"
      || reviewPackage === null
      || reviewPackage.status === "tampered"
      || reviewPackage.status === "deleted"
      || reviewPackage.manifestHash !== decision.reviewedManifestHash) {
      throw new Error("integration task, latest submission, or review is stale");
    }
    return { submission: latest, task };
  }

  #orderedTasks(): OrderedTask[] {
    const tasks = this.#store.listTasks(this.#companyId);
    const byId = new Map(tasks.map((task) => [task.id, task] as const));
    const layers = new Map<string, number>();
    const visiting = new Set<string>();
    const layer = (taskId: string): number => {
      const cached = layers.get(taskId);
      if (cached !== undefined) return cached;
      if (visiting.has(taskId)) {
        throw new Error(`dependency cycle: ${taskId}`);
      }
      const task = byId.get(taskId);
      if (task === undefined) {
        throw new Error(`dependency not found: ${taskId}`);
      }
      visiting.add(taskId);
      let result = 0;
      for (const dependencyId of task.dependencies) {
        if (!byId.has(dependencyId)) {
          throw new Error(`dependency not found: ${dependencyId}`);
        }
        result = Math.max(result, layer(dependencyId) + 1);
      }
      visiting.delete(taskId);
      layers.set(taskId, result);
      return result;
    };
    const events = new Map(
      this.#store.listEvents(0).map((record) => [record.id, record] as const)
    );
    return orderIntegrations(tasks.map((task): OrderedTask => {
      const created = events.get(task.createdEventId);
      if (created === undefined
        || created.type !== "task.created"
        || created.taskId !== task.id) {
        throw new Error(`task creation event binding is invalid: ${task.id}`);
      }
      return {
        taskId: task.id,
        task,
        layer: layer(task.id),
        createdSequence: created.sequence
      };
    }));
  }

  #compareOrdered(left: OrderedIntegration, right: OrderedIntegration): number {
    return left.layer - right.layer
      || left.createdSequence - right.createdSequence
      || left.taskId.localeCompare(right.taskId);
  }

  #isIntegrated(task: TaskRecord): boolean {
    const submission = this.#store
      .listGitSubmissions(this.#runId, task.id)
      .at(-1);
    return task.status === "completed" || submission?.status === "integrated";
  }

  #select(
    submission: GitSubmissionRecord
  ): { kind: "selected"; task: OrderedTask } | { kind: "waiting"; taskId: string } {
    const ordered = this.#orderedTasks();
    const selected = ordered.find(({ taskId }) => taskId === submission.taskId);
    if (selected === undefined) {
      throw new Error(`integration task is not persisted: ${submission.taskId}`);
    }
    const incomplete = selected.task.dependencies.find((dependencyId) =>
      this.#store.getTask(this.#companyId, dependencyId)?.status !== "completed"
    );
    if (incomplete !== undefined) {
      return { kind: "waiting", taskId: incomplete };
    }
    const blocker = ordered.find((candidate) =>
      candidate.layer === selected.layer
      && this.#compareOrdered(candidate, selected) < 0
      && !this.#isIntegrated(candidate.task)
    );
    return blocker === undefined
      ? { kind: "selected", task: selected }
      : { kind: "waiting", taskId: blocker.taskId };
  }

  #orderKey(task: OrderedIntegration): string {
    return [
      String(task.layer).padStart(8, "0"),
      String(task.createdSequence).padStart(20, "0"),
      task.taskId
    ].join(":");
  }

  async #integrationWorkspace(
    run: GitRunRecord,
    expectedCommit: string
  ): Promise<GitWorkspaceRecord> {
    const matches = this.#store.listGitWorkspaces(run.runId).filter(
      (workspace) => workspace.kind === "integration"
        && workspace.taskId === null
        && workspace.employeeId === null
        && workspace.status === "active"
        && workspace.branchRef === run.integrationRef
    );
    if (matches.length !== 1) {
      throw new Error("integration workspace binding is not unique and active");
    }
    const workspace = matches[0]!;
    if (workspace.workspaceId !== `${run.runId}:integration`
      || workspace.headCommit !== expectedCommit) {
      throw new Error("integration workspace head is stale");
    }
    await this.#assertWorkspaceGit(run, workspace, expectedCommit);
    return workspace;
  }

  async #assertCandidateWorkspace(
    workspace: GitWorkspaceRecord,
    attempt: IntegrationAttemptRecord,
    expectedCommit: string
  ): Promise<void> {
    const durable = this.#store.getGitWorkspace(workspace.workspaceId);
    const run = this.#bindRun();
    if (durable === null
      || !sameJson(durable, workspace)
      || workspace.runId !== this.#runId
      || workspace.taskId !== null
      || workspace.employeeId !== null
      || workspace.kind !== "candidate"
      || workspace.status !== "active"
      || workspace.workspaceId
        !== `${this.#runId}:candidate:${attempt.attemptId}`
      || workspace.branchRef !== attempt.candidateRef
      || workspace.baseCommit !== attempt.expectedOldCommit
      || workspace.headCommit !== expectedCommit) {
      throw new Error("candidate workspace is not durably and exactly bound");
    }
    await this.#assertWorkspaceGit(run, workspace, expectedCommit);
  }

  async #assertWorkspaceGit(
    run: GitRunRecord,
    workspace: GitWorkspaceRecord,
    expectedCommit: string
  ): Promise<void> {
    const entries = await this.#git.run(
      ["worktree", "list", "--porcelain"],
      { cwd: run.projectRoot }
    );
    const blocks = entries.stdout.trim().split(/\r?\n\r?\n/u);
    const matching = blocks.filter((block) => block.split(/\r?\n/u)
      .some((line) => line.startsWith("worktree ")
        && pathKey(line.slice("worktree ".length)) === pathKey(workspace.path)));
    if (matching.length !== 1
      || !matching[0]!.split(/\r?\n/u).includes(`HEAD ${expectedCommit}`)
      || !matching[0]!.split(/\r?\n/u).includes(`branch ${workspace.branchRef}`)) {
      throw new Error("Git worktree metadata does not match integration facts");
    }
    const top = await this.#git.run(
      ["rev-parse", "--show-toplevel"],
      { cwd: workspace.path }
    );
    const head = await this.#head(workspace.path);
    const ref = await this.#git.run(
      ["symbolic-ref", "HEAD"],
      { cwd: workspace.path }
    );
    const dirty = await this.#git.run(
      ["status", "--porcelain=v2", "--untracked-files=all"],
      { cwd: workspace.path }
    );
    if (pathKey(top.stdout.trim()) !== pathKey(workspace.path)
      || head !== expectedCommit
      || ref.stdout.trim() !== workspace.branchRef
      || dirty.stdout.length !== 0
      || await this.#readRef(run.projectRoot, workspace.branchRef)
        !== expectedCommit) {
      throw new Error("Git workspace path, ref, head, or cleanliness is invalid");
    }
  }

  async #head(cwd: string): Promise<string> {
    const result = await this.#git.run(["rev-parse", "HEAD"], { cwd });
    const head = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) {
      throw new Error("Git returned an invalid commit object id");
    }
    return head;
  }

  async #readRef(projectRoot: string, ref: string): Promise<string | null> {
    const result = await this.#git.run(
      ["rev-parse", "--verify", "--quiet", ref],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (result.exitCode === 1) return null;
    const head = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) {
      throw new Error("Git returned an invalid ref object id");
    }
    return head;
  }

  async #conflictFiles(candidatePath: string): Promise<string[]> {
    const result = await this.#git.run(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
      { cwd: candidatePath }
    );
    return result.stdout.split("\0").flatMap((entry) => {
      const match = /^u (?:\S+ ){9}([\s\S]+)$/u.exec(entry);
      return match?.[1] === undefined ? [] : [match[1]];
    }).sort();
  }

  #integrationCommands(): ValidationCommand[] {
    const ids = this.#company.validation.integrationCommandIds;
    if (new Set(ids).size !== ids.length) {
      throw new Error("integration validation command ids must be unique");
    }
    return ids.map((id) => {
      const matches = this.#company.validation.commands.filter(
        (command) => command.id === id
      );
      if (matches.length !== 1) {
        throw new Error(`integration validation command is not exact: ${id}`);
      }
      return matches[0]!;
    });
  }

  async #cleanupCandidate(
    workspace: GitWorkspaceRecord,
    expectedCommit: string
  ): Promise<void> {
    const completed: GitWorkspaceRecord = {
      ...workspace,
      headCommit: expectedCommit,
      status: "completed"
    };
    this.#store.commitGitWorkspace({
      workspace: completed,
      event: this.#event("git.workspace.completed", workspace.taskId, {
        workspaceId: workspace.workspaceId,
        headCommit: expectedCommit
      })
    });
    await this.#workspaceManager.removeVerifiedWorkspace(workspace.workspaceId);
    const run = this.#bindRun();
    const deleted = await this.#git.run(
      ["update-ref", "-d", workspace.branchRef, expectedCommit],
      { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
    );
    if (deleted.exitCode !== 0
      || await this.#readRef(run.projectRoot, workspace.branchRef) !== null) {
      throw new Error("candidate ref cleanup requires reconciliation");
    }
  }

  #event(
    type: string,
    taskId: string | null,
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
