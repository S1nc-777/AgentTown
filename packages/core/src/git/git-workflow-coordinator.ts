import { randomUUID } from "node:crypto";
import {
  parseGitTaskSubmission,
  parseReviewDecision,
  type ActionProposal,
  type AgentMessage,
  type CompanyDefinition,
  type EmployeeDefinition,
  type GitSubmissionRecord,
  type GitTaskSubmission,
  type GitWorkspaceRecord,
  type ReviewPackageRecord,
  type TaskRecord,
  type ValidationCommand,
  type ValidationCommandGrant,
  type ValidationRunRecord
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../storage/core-store.js";
import { TaskService } from "../tasks/task-service.js";
import type { EvidencePackageInput } from "./evidence-package.js";
import type { IntegrationResult } from "./integration-service.js";
import type {
  RecordReviewDecisionInput,
  ReviewOutcome
} from "./review-service.js";
import type { ValidatedSubmission } from "./submission-validator.js";
import type { ValidationScope } from "./validation-runner.js";
import type { CreateTaskWorkspaceInput } from "./workspace-manager.js";

interface TaskWorkspaceManager {
  createTaskWorkspace(input: CreateTaskWorkspaceInput): Promise<GitWorkspaceRecord>;
}

interface TaskSubmissionValidator {
  validate(
    workspace: GitWorkspaceRecord,
    submission: GitTaskSubmission
  ): Promise<ValidatedSubmission>;
}

interface TaskValidationRunner {
  requestGrant(
    command: ValidationCommand,
    scope: ValidationScope
  ): Promise<ValidationCommandGrant>;
  run(
    command: ValidationCommand,
    scope: ValidationScope
  ): Promise<ValidationRunRecord>;
}

interface TaskEvidenceBuilder {
  create(input: EvidencePackageInput): Promise<ReviewPackageRecord>;
  verify(record: ReviewPackageRecord): Promise<ReviewPackageRecord>;
}

interface TaskReviewService {
  recordDecision(input: RecordReviewDecisionInput): Promise<ReviewOutcome>;
}

interface ApprovedIntegrationService {
  enqueue(submission: GitSubmissionRecord): Promise<void>;
  drain(): Promise<IntegrationResult | null>;
}

interface ConflictWorkflowService {
  createTask(
    attempt: Extract<IntegrationResult, { kind: "conflicted" }>["attempt"]
  ): Promise<TaskRecord>;
  prepareResolutionWorkspace(input: {
    taskId: string;
    actorEmployeeId: string;
    employeeId: string;
  }): Promise<GitWorkspaceRecord>;
  supersessionFor(taskId: string): Promise<GitSubmissionRecord["supersedes"]>;
}

export interface GitWorkflowCoordinatorOptions {
  store: CoreStore;
  companyId: string;
  company: CompanyDefinition;
  runId: string;
  tasks: TaskService;
  workspaceManager: TaskWorkspaceManager;
  submissionValidator: TaskSubmissionValidator;
  validationRunner: TaskValidationRunner;
  evidenceBuilder: TaskEvidenceBuilder;
  reviewService: TaskReviewService;
  integrationService?: ApprovedIntegrationService;
  conflictService?: ConflictWorkflowService;
  reviewerIds: ReadonlySet<string>;
  sendMessage(employeeId: string, message: AgentMessage): Promise<void>;
  leaderId?: string;
}

export type AssignTaskOutcome = {
  kind: "running";
  task: TaskRecord;
  workspace: GitWorkspaceRecord;
};

export type SubmitTaskOutcome =
  | {
      kind: "pending_approval";
      grants: ValidationCommandGrant[];
      ownerEmployeeId: string;
    }
  | {
      kind: "grant_rejected";
      grantId: string;
      ownerEmployeeId: string;
      reason: string;
    }
  | {
      kind: "in_review";
      revision: number;
      submission: GitSubmissionRecord;
      reviewPackage: ReviewPackageRecord;
    };

function requiredTaskId(action: ActionProposal): string {
  if (action.taskId === null) throw new Error(`${action.type} requires taskId`);
  return action.taskId;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("review revision must be a positive integer");
  }
  return value as number;
}

function sameCommand(left: ValidationCommand, right: ValidationCommand): boolean {
  return left.id === right.id
    && left.executable === right.executable
    && left.cwd === right.cwd
    && left.timeoutSeconds === right.timeoutSeconds
    && left.args.length === right.args.length
    && left.args.every((argument, index) => argument === right.args[index]);
}

export class GitWorkflowCoordinator {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #runId: string;
  readonly #tasks: TaskService;
  readonly #workspaceManager: TaskWorkspaceManager;
  readonly #submissionValidator: TaskSubmissionValidator;
  readonly #validationRunner: TaskValidationRunner;
  readonly #evidenceBuilder: TaskEvidenceBuilder;
  readonly #reviewService: TaskReviewService;
  readonly #integrationService: ApprovedIntegrationService | undefined;
  readonly #conflictService: ConflictWorkflowService | undefined;
  readonly #reviewerIds: ReadonlySet<string>;
  readonly #sendMessage: GitWorkflowCoordinatorOptions["sendMessage"];
  readonly #leaderId: string;
  #acceptingActions = true;

  constructor(options: GitWorkflowCoordinatorOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#runId = options.runId;
    this.#tasks = options.tasks;
    this.#workspaceManager = options.workspaceManager;
    this.#submissionValidator = options.submissionValidator;
    this.#validationRunner = options.validationRunner;
    this.#evidenceBuilder = options.evidenceBuilder;
    this.#reviewService = options.reviewService;
    this.#integrationService = options.integrationService;
    this.#conflictService = options.conflictService;
    this.#reviewerIds = options.reviewerIds;
    this.#sendMessage = options.sendMessage;
    this.#leaderId = options.leaderId ?? this.#deriveLeaderId();
  }

  handles(action: ActionProposal): boolean {
    if (!this.#acceptingActions) return false;
    const run = this.#store.getGitRun(this.#runId);
    if (run === null || run.companyId !== this.#companyId || run.status !== "active") {
      return false;
    }
    if (action.type === "task.assign") {
      const assignee = action.payload.assignee;
      return typeof assignee === "string"
        && this.#employee(assignee).workspace === "git_worktree";
    }
    if (action.taskId === null) return false;
    const task = this.#store.getTask(this.#companyId, action.taskId);
    if (task?.ownerEmployeeId === null || task?.ownerEmployeeId === undefined) {
      return false;
    }
    return this.#employee(task.ownerEmployeeId).workspace === "git_worktree";
  }

  stopNewActions(): void {
    this.#acceptingActions = false;
  }

  async assignTask(action: ActionProposal): Promise<AssignTaskOutcome> {
    if (action.type !== "task.assign") {
      throw new Error("Git assignTask requires task.assign");
    }
    this.#bindCompanyAndRun();
    if (action.actorEmployeeId !== this.#leaderId) {
      throw new Error("leader permission required");
    }
    const taskId = requiredTaskId(action);
    const assigneeId = requiredString(action.payload.assignee, "assignee");
    const assignee = this.#employee(assigneeId);
    if (assignee.workspace !== "git_worktree") {
      throw new Error(`employee requires git_worktree workspace: ${assigneeId}`);
    }
    const run = this.#requiredRun();
    const before = this.#tasks.get(taskId);
    if (before.status !== "draft"
      && !(before.status === "ready" && before.ownerEmployeeId === assigneeId)) {
      throw new Error("Git task assignment is stale or belongs to another employee");
    }

    let workspace: GitWorkspaceRecord;
    if (before.conflictForTaskId !== null) {
      if (this.#conflictService === undefined) {
        throw new Error("conflict workflow service is required");
      }
      workspace = await this.#conflictService.prepareResolutionWorkspace({
        taskId,
        actorEmployeeId: action.actorEmployeeId,
        employeeId: assigneeId
      });
    } else {
      workspace = this.#taskWorkspace(taskId, assigneeId)
        ?? await this.#workspaceManager.createTaskWorkspace({
          runId: this.#runId,
          employeeId: assigneeId,
          taskId,
          baseCommit: run.integrationCommit
        });
    }
    this.#assertWorkspace(workspace, taskId, assigneeId);
    const assigned = before.status === "draft"
      ? this.#tasks.assign(taskId, assigneeId)
      : before;
    const approvedValidationCommandIds = this.#store
      .listValidationCommandGrants(this.#runId, taskId)
      .filter((grant) =>
        grant.workspaceId === workspace.workspaceId
        && grant.status === "approved"
      )
      .map(({ command }) => command.id)
      .sort();
    await this.#sendMessage(assignee.id, {
      messageId: randomUUID(),
      employeeId: assignee.id,
      taskId,
      text: [
        assigned.objective,
        `Acceptance criteria: ${assigned.acceptanceCriteria.join("; ")}`
      ].join("\n"),
      actionRequest: action,
      taskContext: {
        kind: "git_worktree",
        runId: this.#runId,
        taskId,
        employeeId: assignee.id,
        workspaceRoot: workspace.path,
        branch: workspace.branchRef,
        baseCommit: workspace.baseCommit,
        approvedValidationCommandIds
      }
    });
    const running = this.#tasks.transition(taskId, "running", assignee.id);
    return { kind: "running", task: running, workspace };
  }

  async submitTask(action: ActionProposal): Promise<SubmitTaskOutcome> {
    if (action.type !== "task.submit") {
      throw new Error("Git submitTask requires task.submit");
    }
    this.#bindCompanyAndRun();
    const taskId = requiredTaskId(action);
    const task = this.#tasks.get(taskId);
    if (task.status !== "running"
      || task.ownerEmployeeId === null
      || task.ownerEmployeeId !== action.actorEmployeeId) {
      throw new Error("running task owner required for Git submission");
    }
    const employee = this.#employee(action.actorEmployeeId);
    if (employee.workspace !== "git_worktree") {
      throw new Error("Git submission requires git_worktree employee");
    }
    const workspace = this.#taskWorkspace(taskId, employee.id);
    if (workspace === null) {
      throw new Error("Git submission task workspace is not registered");
    }
    this.#assertWorkspace(workspace, taskId, employee.id);
    const parsed = parseGitTaskSubmission(action.payload.submission);
    const scope: ValidationScope = {
      runId: this.#runId,
      taskId,
      integrationAttemptId: null,
      workspaceId: workspace.workspaceId,
      workspaceRoot: workspace.path
    };

    const suggestedById = new Map<string, ValidationCommand>();
    const grants: ValidationCommandGrant[] = [];
    for (const suggested of parsed.suggestedValidationCommands) {
      if (suggestedById.has(suggested.id)) {
        throw new Error(`duplicate suggested validation command id: ${suggested.id}`);
      }
      suggestedById.set(suggested.id, suggested);
      const configuredWithSameId = this.#company.validation.commands.find(
        ({ id }) => id === suggested.id
      );
      if (configuredWithSameId !== undefined
        && !sameCommand(configuredWithSameId, suggested)) {
        throw new Error(
          `suggested validation command conflicts with configured id: ${suggested.id}`
        );
      }
      const configured = this.#company.validation.commands.find(
        (candidate) => sameCommand(candidate, suggested)
      );
      if (configured !== undefined) continue;
      const grant = await this.#validationRunner.requestGrant(suggested, scope);
      if (!sameCommand(grant.command, suggested)
        || grant.runId !== this.#runId
        || grant.taskId !== taskId
        || grant.workspaceId !== workspace.workspaceId) {
        throw new Error("validation grant does not exactly match submission scope");
      }
      grants.push(grant);
    }
    const rejected = grants.find(({ status }) => status === "rejected");
    if (rejected !== undefined) {
      return {
        kind: "grant_rejected",
        grantId: rejected.grantId,
        ownerEmployeeId: employee.id,
        reason: rejected.decisionReason ?? "validation command rejected"
      };
    }
    const pending = grants.filter(({ status }) => status === "pending");
    if (pending.length > 0) {
      return {
        kind: "pending_approval",
        grants: pending,
        ownerEmployeeId: employee.id
      };
    }

    const validationCommands: ValidationCommand[] = [];
    const seenCommandIds = new Set<string>();
    for (const commandId of parsed.validationCommandIds) {
      if (seenCommandIds.has(commandId)) {
        throw new Error(`duplicate validation command id: ${commandId}`);
      }
      seenCommandIds.add(commandId);
      const configured = this.#company.validation.commands.find(
        ({ id }) => id === commandId
      );
      const suggested = suggestedById.get(commandId);
      const approved = suggested === undefined
        ? undefined
        : grants.find((grant) =>
            grant.status === "approved" && sameCommand(grant.command, suggested)
          )?.command;
      const command = configured ?? approved;
      if (command === undefined) {
        throw new Error(
          `validation command is not configured or exactly approved: ${commandId}`
        );
      }
      validationCommands.push(command);
    }
    for (const [commandId] of suggestedById) {
      if (!seenCommandIds.has(commandId)) {
        throw new Error(
          `suggested validation command must be requested by id: ${commandId}`
        );
      }
    }
    const gitFacts = await this.#submissionValidator.validate(workspace, {
      ...parsed,
      validationCommandIds: []
    });
    for (const command of validationCommands) {
      const result = await this.#validationRunner.run(command, scope);
      if (result.runId !== this.#runId
        || result.taskId !== taskId
        || result.workspaceId !== workspace.workspaceId
        || !sameCommand(result.command, command)
        || result.outcome !== "passed") {
        throw new Error(
          `validation failed: ${command.id}: ${result.outcome}`
        );
      }
    }

    const validated = validationCommands.length === 0
      ? gitFacts
      : await this.#submissionValidator.validate(workspace, parsed);
    const latest = this.#store.listGitSubmissions(this.#runId, taskId).at(-1);
    const revision = (latest?.revision ?? 0) + 1;
    const supersedes = task.conflictForTaskId === null
      ? null
      : await this.#requiredConflictService().supersessionFor(taskId);
    const validatedRecord: GitSubmissionRecord = {
      runId: this.#runId,
      taskId,
      revision,
      submission: parsed,
      status: "validated",
      supersedes
    };
    this.#store.commitGitSubmissionCreation({
      submission: validatedRecord,
      event: this.#event("git.submission.validated", taskId, {
        runId: this.#runId,
        revision,
        workspaceId: workspace.workspaceId,
        headCommit: parsed.headCommit
      })
    });
    const reviewPackage = await this.#evidenceBuilder.create({
      ...validated,
      submission: parsed,
      revision
    });
    await this.#evidenceBuilder.verify(reviewPackage);
    if (reviewPackage.runId !== this.#runId
      || reviewPackage.taskId !== taskId
      || reviewPackage.revision !== revision) {
      throw new Error("created review package does not match submission revision");
    }
    const reviewEvent = this.#event("task.review_requested", taskId, {
      runId: this.#runId,
      revision,
      manifestPath: reviewPackage.manifestPath,
      manifestHash: reviewPackage.manifestHash
    });
    const submittedEvent = this.#event("task.submitted", taskId, {
      runId: this.#runId,
      revision,
      workspaceId: workspace.workspaceId
    });
    const reviewTask: TaskRecord = {
      ...task,
      status: "review",
      artifacts: [reviewPackage.manifestPath],
      evidence: [reviewPackage.manifestHash],
      updatedEventId: reviewEvent.id
    };
    const inReview: GitSubmissionRecord = {
      ...validatedRecord,
      status: "in_review"
    };
    this.#store.commitGitSubmissionReviewStart({
      companyId: this.#companyId,
      submission: inReview,
      task: reviewTask,
      reviewPackage,
      events: [submittedEvent, reviewEvent]
    });

    const reviewer = this.#reviewer(task.ownerEmployeeId);
    await this.#sendMessage(reviewer.id, {
      messageId: randomUUID(),
      employeeId: reviewer.id,
      taskId,
      text: `Review immutable evidence package for ${taskId}, revision ${revision}.`,
      actionRequest: null,
      taskContext: {
        kind: "review_package",
        runId: this.#runId,
        taskId,
        revision,
        manifestPath: reviewPackage.manifestPath,
        manifestHash: reviewPackage.manifestHash
      }
    });
    return {
      kind: "in_review",
      revision,
      submission: inReview,
      reviewPackage
    };
  }

  async recordReview(action: ActionProposal): Promise<ReviewOutcome> {
    if (action.type !== "task.approve" && action.type !== "task.reject") {
      throw new Error("Git recordReview requires task.approve or task.reject");
    }
    this.#bindCompanyAndRun();
    const taskId = requiredTaskId(action);
    const reviewer = this.#employee(action.actorEmployeeId);
    if (!this.#reviewerIds.has(reviewer.id)
      || reviewer.workspace !== "review_package") {
      throw new Error("review permission required");
    }
    const parsedDecision = parseReviewDecision(action.payload.decision);
    if ((action.type === "task.approve") !== (parsedDecision.decision === "approve")) {
      throw new Error("review action type and structured decision disagree");
    }
    const outcome = await this.#reviewService.recordDecision({
      runId: this.#runId,
      task: this.#tasks.get(taskId),
      reviewerId: reviewer.id,
      revision: requiredRevision(action.payload.revision),
      decision: parsedDecision
    });
    if (outcome.kind === "approved" && this.#integrationService !== undefined) {
      await this.#integrationService.enqueue(outcome.submission);
      const integration = await this.#integrationService.drain();
      if (integration?.kind === "conflicted") {
        await this.#requiredConflictService().createTask(integration.attempt);
      }
    }
    return outcome;
  }

  #bindCompanyAndRun(): void {
    if (!this.#acceptingActions) {
      throw new Error("Git workflow dispatch is fenced");
    }
    const company = this.#store.getCompany(this.#companyId);
    const run = this.#store.getGitRun(this.#runId);
    if (company === null
      || company.definitionJson !== JSON.stringify(this.#company)
      || run === null
      || run.companyId !== this.#companyId
      || run.status !== "active") {
      throw new Error("Git workflow company or run binding is not active");
    }
  }

  #requiredRun() {
    const run = this.#store.getGitRun(this.#runId);
    if (run === null) throw new Error(`Git run not found: ${this.#runId}`);
    return run;
  }

  #employee(employeeId: string): EmployeeDefinition {
    const employee = this.#company.employees.find(({ id }) => id === employeeId);
    if (employee === undefined) throw new Error(`unknown employee: ${employeeId}`);
    return employee;
  }

  #requiredConflictService(): ConflictWorkflowService {
    if (this.#conflictService === undefined) {
      throw new Error("conflict workflow service is required");
    }
    return this.#conflictService;
  }

  #deriveLeaderId(): string {
    const leaders = this.#company.employees.filter(
      ({ reportsTo, workspace }) => reportsTo === "owner" && workspace === "read_only"
    );
    if (leaders.length !== 1) {
      throw new Error("Git workflow requires one configured read-only leader");
    }
    return leaders[0]!.id;
  }

  #reviewer(ownerEmployeeId: string): EmployeeDefinition {
    const reviewers = this.#company.employees.filter(
      (employee) => this.#reviewerIds.has(employee.id)
        && employee.workspace === "review_package"
        && employee.id !== ownerEmployeeId
    );
    if (reviewers.length !== 1) {
      throw new Error("Git workflow requires one authorized non-owner reviewer");
    }
    return reviewers[0]!;
  }

  #taskWorkspace(taskId: string, employeeId: string): GitWorkspaceRecord | null {
    const matches = this.#store.listGitWorkspaces(this.#runId).filter(
      (workspace) => workspace.kind === "task"
        && workspace.taskId === taskId
        && workspace.employeeId === employeeId
        && workspace.status === "active"
    );
    if (matches.length > 1) {
      throw new Error("multiple active task workspaces are registered");
    }
    return matches[0] ?? null;
  }

  #assertWorkspace(
    workspace: GitWorkspaceRecord,
    taskId: string,
    employeeId: string
  ): void {
    const durable = this.#store.getGitWorkspace(workspace.workspaceId);
    if (durable === null
      || JSON.stringify(durable) !== JSON.stringify(workspace)
      || workspace.runId !== this.#runId
      || workspace.taskId !== taskId
      || workspace.employeeId !== employeeId
      || workspace.kind !== "task"
      || workspace.status !== "active") {
      throw new Error("task workspace is not durably and exactly registered");
    }
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
