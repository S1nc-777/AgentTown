import { randomUUID } from "node:crypto";
import type {
  GitSubmissionRecord,
  ReviewDecision,
  ReviewPackageRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewService } from "../src/git/review-service.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import { companyDefinitionFixture } from "./helpers.js";

const stores: CoreStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function decision(
  manifestHash: string,
  kind: "approve" | "reject" = "approve"
): ReviewDecision {
  return {
    schemaVersion: 1,
    decision: kind,
    findings: kind === "approve"
      ? [{
          severity: "advisory",
          evidence: "The implementation is intentionally small.",
          requiredChange: null
        }]
      : [{
          severity: "blocking",
          evidence: "The focused test is failing.",
          requiredChange: "Make the focused test pass."
        }],
    coverageGaps: [],
    summary: kind === "approve" ? "Ready for integration." : "Changes required.",
    reviewedManifestHash: manifestHash
  };
}

function createHarness(maxReviewLoops: 0 | 1 | 2 = 2): {
  store: CoreStore;
  tasks: TaskService;
  service: ReviewService;
  packageRecord: ReviewPackageRecord;
  verify: ReturnType<typeof vi.fn>;
} {
  const company = companyDefinitionFixture();
  company.limits.maxReviewLoops = maxReviewLoops;
  const store = new CoreStore(":memory:");
  stores.push(store);
  store.initialize();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: {
      id: randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: {}
    }
  });
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: process.cwd(),
    originalBranch: "main",
    baseCommit: "1".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "1".repeat(40),
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  });
  store.putGitWorkspace({
    workspaceId: "run-1:task:developer:task-a",
    runId: "run-1",
    taskId: "task-a",
    employeeId: "developer",
    kind: "task",
    path: process.cwd(),
    branchRef: "refs/heads/agenttown/run-1/developer/task-a",
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    status: "active"
  });
  const tasks = new TaskService(store, "company-1", company, "leader");
  tasks.create({
    id: "task-a",
    title: "Task A",
    objective: "Complete Task A",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: ["Focused tests pass"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    conflictForTaskId: null
  });
  tasks.assign("task-a", "developer");
  tasks.transition("task-a", "running", "developer");
  tasks.submit("task-a", "developer", ["changes.patch"], ["manifest.json"]);
  const submission: GitSubmissionRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    submission: {
      schemaVersion: 1,
      headCommit: "2".repeat(40),
      commits: ["2".repeat(40)],
      changeSummary: "Implement Task A",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    },
    status: "in_review",
    supersedes: null
  };
  store.putGitSubmission(submission);
  const packageRecord: ReviewPackageRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    manifestPath: "C:\\evidence\\run-1\\task-a\\1\\manifest.json",
    manifestHash: "a".repeat(64),
    totalBytes: 123,
    status: "created"
  };
  store.putReviewPackage(packageRecord);
  const verify = vi.fn(async (record: ReviewPackageRecord) => record);
  const service = new ReviewService({
    store,
    companyId: "company-1",
    company,
    evidenceBuilder: { verify },
    reviewerIds: new Set(["reviewer"])
  });
  return { store, tasks, service, packageRecord, verify };
}

async function record(
  service: ReviewService,
  task: TaskRecord,
  review: unknown,
  revision = 1,
  reviewerId = "reviewer"
) {
  return await service.recordDecision({
    runId: "run-1",
    task,
    reviewerId,
    revision,
    decision: review
  });
}

describe("ReviewService", () => {
  it("keeps an approved task in review and preserves advisory findings", async () => {
    const { packageRecord, service, store, tasks, verify } = createHarness();

    const outcome = await record(
      service,
      tasks.get("task-a"),
      decision(packageRecord.manifestHash)
    );

    expect(outcome.kind).toBe("approved");
    expect(tasks.get("task-a").status).toBe("review");
    expect(store.getGitSubmission("run-1", "task-a", 1)?.status).toBe("approved");
    expect(store.getReviewDecision("run-1", "task-a", 1)?.findings).toEqual(
      decision(packageRecord.manifestHash).findings
    );
    expect(verify).toHaveBeenCalledWith(packageRecord);
  });

  it("returns a rejected task to the same owner and increments review loops", async () => {
    const { packageRecord, service, store, tasks } = createHarness();

    const outcome = await record(
      service,
      tasks.get("task-a"),
      decision(packageRecord.manifestHash, "reject")
    );

    expect(outcome.kind).toBe("changes_requested");
    expect(tasks.get("task-a")).toMatchObject({
      status: "running",
      ownerEmployeeId: "developer",
      reviewLoopCount: 1
    });
    expect(store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("changes_requested");
  });

  it.each([0, 1] as const)(
    "escalates the first rejection when maxReviewLoops is %i with one idempotent approval",
    async (maxReviewLoops) => {
      const { packageRecord, service, store, tasks } = createHarness(maxReviewLoops);
      const rejecting = decision(packageRecord.manifestHash, "reject");

      const outcome = await record(service, tasks.get("task-a"), rejecting);

      expect(outcome.kind).toBe("escalated");
      expect(tasks.get("task-a")).toMatchObject({
        status: "blocked",
        ownerEmployeeId: "developer",
        reviewLoopCount: 1
      });
      expect(store.listPendingApprovals("company-1")).toHaveLength(1);
      await expect(record(service, tasks.get("task-a"), rejecting))
        .rejects.toThrow(/stale|already|in_review/u);
      expect(store.listPendingApprovals("company-1")).toHaveLength(1);
    }
  );

  it("escalates after the configured second rejection without overwriting revision one", async () => {
    const { packageRecord, service, store, tasks } = createHarness(2);
    await record(
      service,
      tasks.get("task-a"),
      decision(packageRecord.manifestHash, "reject")
    );
    const firstDecision = store.getReviewDecision("run-1", "task-a", 1);
    tasks.submit("task-a", "developer", ["changes-v2.patch"], ["manifest-v2.json"]);
    const revisionTwo: GitSubmissionRecord = {
      ...store.getGitSubmission("run-1", "task-a", 1)!,
      revision: 2,
      status: "in_review"
    };
    store.putGitSubmission(revisionTwo);
    const packageTwo: ReviewPackageRecord = {
      ...packageRecord,
      revision: 2,
      manifestPath: "C:\\evidence\\run-1\\task-a\\2\\manifest.json",
      manifestHash: "b".repeat(64)
    };
    store.putReviewPackage(packageTwo);

    const outcome = await record(
      service,
      tasks.get("task-a"),
      decision(packageTwo.manifestHash, "reject"),
      2
    );

    expect(outcome.kind).toBe("escalated");
    expect(tasks.get("task-a")).toMatchObject({
      status: "blocked",
      ownerEmployeeId: "developer",
      reviewLoopCount: 2
    });
    expect(store.listPendingApprovals("company-1")).toHaveLength(1);
    expect(store.getReviewDecision("run-1", "task-a", 1)).toEqual(firstDecision);
    expect(store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("changes_requested");
  });

  it("rejects malformed, stale, self, unconfigured, and hash-mismatched reviews", async () => {
    const { packageRecord, service, store, tasks, verify } = createHarness();
    const current = tasks.get("task-a");

    await expect(record(service, current, { decision: "approve" }))
      .rejects.toThrow();
    await expect(record(
      service,
      current,
      decision("b".repeat(64))
    )).rejects.toThrow("manifest hash");
    await expect(record(
      service,
      current,
      decision(packageRecord.manifestHash),
      1,
      "developer"
    )).rejects.toThrow(/review permission|owner/u);
    await expect(record(
      service,
      current,
      decision(packageRecord.manifestHash),
      1,
      "leader"
    )).rejects.toThrow("review permission");
    await expect(record(
      service,
      current,
      decision(packageRecord.manifestHash),
      2
    )).rejects.toThrow(/latest|revision|submission/u);

    expect(store.listReviewDecisions("run-1", "task-a")).toHaveLength(0);
    expect(tasks.get("task-a").status).toBe("review");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("commits the decision, submission, task, approval and events atomically", async () => {
    const { packageRecord, service, store, tasks } = createHarness(1);
    const duplicateEventId = randomUUID();
    store.insertEvent({
      id: duplicateEventId,
      type: "fixture.duplicate",
      actorId: "core",
      taskId: "task-a",
      causationEventId: null,
      payload: {}
    });

    await expect(service.recordDecision({
      runId: "run-1",
      task: tasks.get("task-a"),
      reviewerId: "reviewer",
      revision: 1,
      decision: decision(packageRecord.manifestHash, "reject"),
      eventIds: {
        decision: duplicateEventId,
        task: randomUUID(),
        approval: randomUUID()
      }
    })).rejects.toThrow();

    expect(store.getReviewDecision("run-1", "task-a", 1)).toBeNull();
    expect(store.getGitSubmission("run-1", "task-a", 1)?.status).toBe("in_review");
    expect(tasks.get("task-a")).toMatchObject({
      status: "review",
      reviewLoopCount: 0
    });
    expect(store.listPendingApprovals("company-1")).toHaveLength(0);
  });

  it("keeps low-level review decisions immutable for an existing revision", () => {
    const { packageRecord, store } = createHarness();
    const approved = decision(packageRecord.manifestHash);
    store.putReviewDecision({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      decision: approved
    });
    expect(() => store.putReviewDecision({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      decision: decision(packageRecord.manifestHash, "reject")
    })).toThrow("immutable");
    expect(store.getReviewDecision("run-1", "task-a", 1)).toEqual(approved);
  });

  it.each([
    {
      label: "foreign submission run",
      mutate: (submission: GitSubmissionRecord): GitSubmissionRecord => ({
        ...submission,
        runId: "run-other",
        status: "approved"
      })
    },
    {
      label: "decision-inconsistent submission status",
      mutate: (submission: GitSubmissionRecord): GitSubmissionRecord => ({
        ...submission,
        status: "changes_requested"
      })
    }
  ])("atomically rejects $label in direct review commits", ({ mutate }) => {
    const { packageRecord, store, tasks } = createHarness();
    const taskBefore = tasks.get("task-a");
    const submissionBefore = store.getGitSubmission("run-1", "task-a", 1)!;
    const taskEventId = randomUUID();

    expect(() => store.commitGitReviewDecision({
      companyId: "company-1",
      runId: "run-1",
      task: {
        ...taskBefore,
        status: "review",
        updatedEventId: taskEventId
      },
      submission: mutate(submissionBefore),
      decision: decision(packageRecord.manifestHash),
      events: [{
        id: randomUUID(),
        type: "review.approved",
        actorId: "reviewer",
        taskId: "task-a",
        causationEventId: null,
        payload: {}
      }, {
        id: taskEventId,
        type: "task.review_approved",
        actorId: "reviewer",
        taskId: "task-a",
        causationEventId: null,
        payload: {}
      }]
    })).toThrow(/submission|review decision|mismatch/u);

    expect(store.getReviewDecision("run-1", "task-a", 1)).toBeNull();
    expect(store.getGitSubmission("run-1", "task-a", 1)).toEqual(submissionBefore);
    expect(store.getGitSubmission("run-other", "task-a", 1)).toBeNull();
    expect(tasks.get("task-a")).toEqual(taskBefore);
  });
});
