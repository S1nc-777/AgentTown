import { randomUUID } from "node:crypto";
import {
  parseReviewDecision,
  type CompanyDefinition,
  type GitSubmissionRecord,
  type ReviewDecision,
  type ReviewPackageRecord,
  type TaskRecord
} from "@agenttown/runtime-contract";
import {
  CoreStore,
  type ApprovalRecord,
  type NewEvent
} from "../storage/core-store.js";

interface EvidenceVerifier {
  verify(record: ReviewPackageRecord): Promise<ReviewPackageRecord>;
}

export interface ReviewServiceOptions {
  store: CoreStore;
  companyId: string;
  company: CompanyDefinition;
  evidenceBuilder: EvidenceVerifier;
  reviewerIds: ReadonlySet<string>;
  actorId?: string;
}

export interface RecordReviewDecisionInput {
  runId: string;
  task: TaskRecord;
  reviewerId: string;
  revision: number;
  decision: unknown;
  eventIds?: {
    decision: string;
    task: string;
    approval: string;
  };
}

export type ReviewOutcome =
  | { kind: "approved"; submission: GitSubmissionRecord }
  | { kind: "changes_requested"; task: TaskRecord }
  | { kind: "escalated"; task: TaskRecord; approvalId: string };

interface BoundReview {
  task: TaskRecord;
  submission: GitSubmissionRecord;
  reviewPackage: ReviewPackageRecord;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ReviewService {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #company: CompanyDefinition;
  readonly #evidenceBuilder: EvidenceVerifier;
  readonly #reviewerIds: ReadonlySet<string>;
  readonly #actorId: string;

  constructor(options: ReviewServiceOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#company = options.company;
    this.#evidenceBuilder = options.evidenceBuilder;
    this.#reviewerIds = options.reviewerIds;
    this.#actorId = options.actorId ?? "core";
  }

  async recordDecision(input: RecordReviewDecisionInput): Promise<ReviewOutcome> {
    const bound = this.#bind(input);
    const decision = parseReviewDecision(input.decision);
    await this.#evidenceBuilder.verify(bound.reviewPackage);
    if (decision.reviewedManifestHash !== bound.reviewPackage.manifestHash) {
      throw new Error("reviewed manifest hash does not match the current package");
    }

    const rebound = this.#bind(input);
    if (!sameJson(rebound, bound)) {
      throw new Error("review facts changed during package verification");
    }

    const decisionEventId = input.eventIds?.decision ?? randomUUID();
    const taskEventId = input.eventIds?.task ?? randomUUID();
    const approvalEventId = input.eventIds?.approval ?? randomUUID();
    const decidedSubmission: GitSubmissionRecord = {
      ...bound.submission,
      status: decision.decision === "approve" ? "approved" : "changes_requested"
    };
    const events: NewEvent[] = [{
      id: decisionEventId,
      type: decision.decision === "approve"
        ? "review.approved"
        : "review.changes_requested",
      actorId: input.reviewerId,
      taskId: bound.task.id,
      causationEventId: null,
      payload: {
        runId: input.runId,
        revision: input.revision,
        manifestHash: bound.reviewPackage.manifestHash,
        findings: decision.findings,
        coverageGaps: decision.coverageGaps,
        summary: decision.summary
      }
    }];

    if (decision.decision === "approve") {
      const task: TaskRecord = {
        ...bound.task,
        status: "review",
        updatedEventId: taskEventId
      };
      events.push(this.#taskEvent(
        taskEventId,
        "task.review_approved",
        input.reviewerId,
        task,
        { revision: input.revision }
      ));
      this.#store.commitGitReviewDecision({
        companyId: this.#companyId,
        runId: input.runId,
        task,
        submission: decidedSubmission,
        decision,
        events
      });
      return { kind: "approved", submission: decidedSubmission };
    }

    const reviewLoopCount = bound.task.reviewLoopCount + 1;
    const escalated = reviewLoopCount >= this.#company.limits.maxReviewLoops;
    const task: TaskRecord = {
      ...bound.task,
      status: escalated ? "blocked" : "running",
      reviewLoopCount,
      updatedEventId: taskEventId
    };
    events.push(this.#taskEvent(
      taskEventId,
      escalated ? "task.blocked" : "task.rework_requested",
      input.reviewerId,
      task,
      {
        revision: input.revision,
        reviewLoopCount,
        findings: decision.findings
      }
    ));
    let approval: ApprovalRecord | undefined;
    if (escalated) {
      const approvalId = [
        "review-loop",
        this.#companyId,
        input.runId,
        task.id
      ].join(":");
      const createdAt = new Date().toISOString();
      approval = {
        id: approvalId,
        companyId: this.#companyId,
        taskId: task.id,
        status: "pending",
        request: {
          reason: "review_rejection_limit_reached",
          runId: input.runId,
          taskId: task.id,
          revision: input.revision,
          reviewLoopCount,
          maxReviewLoops: this.#company.limits.maxReviewLoops,
          operation: `resolve review rejection limit for ${task.id}`,
          impact: "Automatic review rework is blocked.",
          alternatives: ["allow_rework", "stop_task"],
          consequenceOfNonApproval: "The task remains blocked.",
          question: `Should ${task.id} receive another review loop?`,
          options: ["allow_rework", "stop_task"]
        },
        decision: null,
        createdAt,
        decidedAt: null
      };
      events.push({
        id: approvalEventId,
        type: "user.approval.requested",
        actorId: this.#actorId,
        taskId: task.id,
        causationEventId: null,
        payload: {
          approvalId,
          ...approval.request
        }
      });
    }
    this.#store.commitGitReviewDecision({
      companyId: this.#companyId,
      runId: input.runId,
      task,
      submission: decidedSubmission,
      decision,
      ...(approval === undefined ? {} : { approval }),
      events
    });
    return approval === undefined
      ? { kind: "changes_requested", task }
      : { kind: "escalated", task, approvalId: approval.id };
  }

  #bind(input: RecordReviewDecisionInput): BoundReview {
    const persistedCompany = this.#store.getCompany(this.#companyId);
    const run = this.#store.getGitRun(input.runId);
    const currentTask = this.#store.getTask(this.#companyId, input.task.id);
    if (persistedCompany === null
      || persistedCompany.definitionJson !== JSON.stringify(this.#company)
      || run === null
      || run.companyId !== this.#companyId
      || run.status !== "active") {
      throw new Error("review company or run binding is not active");
    }
    if (currentTask === null || !sameJson(currentTask, input.task)
      || currentTask.status !== "review") {
      throw new Error("review task binding is stale or not in review");
    }
    const reviewer = this.#company.employees.find(
      ({ id }) => id === input.reviewerId
    );
    if (reviewer === undefined
      || !this.#reviewerIds.has(input.reviewerId)
      || reviewer.workspace !== "review_package") {
      throw new Error("review permission required");
    }
    if (currentTask.ownerEmployeeId === input.reviewerId) {
      throw new Error("task owner cannot review their own submission");
    }
    const ownerWorkspace = this.#store.listGitWorkspaces(input.runId).filter(
      (workspace) => workspace.kind === "task"
        && workspace.taskId === currentTask.id
        && workspace.employeeId === currentTask.ownerEmployeeId
        && workspace.status === "active"
    );
    if (ownerWorkspace.length !== 1) {
      throw new Error("review task workspace binding is not unique and active");
    }
    const submissions = this.#store.listGitSubmissions(
      input.runId,
      currentTask.id
    );
    const submission = submissions.at(-1);
    if (submission === undefined
      || submission.revision !== input.revision
      || submission.status !== "in_review") {
      throw new Error("review submission revision is not latest and in_review");
    }
    if (this.#store.getReviewDecision(
      input.runId,
      currentTask.id,
      input.revision
    ) !== null) {
      throw new Error("review submission revision is already decided");
    }
    const reviewPackage = this.#store.getReviewPackage(
      input.runId,
      currentTask.id,
      input.revision
    );
    if (reviewPackage === null
      || reviewPackage.runId !== input.runId
      || reviewPackage.taskId !== currentTask.id
      || reviewPackage.revision !== submission.revision
      || reviewPackage.status === "tampered"
      || reviewPackage.status === "deleted") {
      throw new Error("review package binding is missing or invalid");
    }
    return { task: currentTask, submission, reviewPackage };
  }

  #taskEvent(
    id: string,
    type: string,
    actorId: string,
    task: TaskRecord,
    payload: Record<string, unknown>
  ): NewEvent {
    return {
      id,
      type,
      actorId,
      taskId: task.id,
      causationEventId: null,
      payload
    };
  }
}
