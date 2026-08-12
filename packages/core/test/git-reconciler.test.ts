import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  GitSubmissionRecord,
  GitTaskSubmission,
  ReviewPackageRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitReconciler } from "../src/git/git-reconciler.js";
import { IntegrationService } from "../src/git/integration-service.js";
import { ValidationRunner } from "../src/git/validation-runner.js";
import { WorkspaceManager } from "../src/git/workspace-manager.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import { companyDefinitionFixture } from "./helpers.js";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function event(type: string, taskId: string | null) {
  return {
    id: randomUUID(),
    type,
    actorId: "core",
    taskId,
    causationEventId: null,
    payload: {}
  };
}

function submission(headCommit: string): GitTaskSubmission {
  return {
    schemaVersion: 1,
    headCommit,
    commits: [headCommit],
    changeSummary: "Reviewed change",
    validationCommandIds: [],
    suggestedValidationCommands: [],
    reportedResults: [],
    knownRisks: []
  };
}

async function setup(options: {
  preparedAt?: "old" | "new";
  evidenceFailure?: Error;
} = {}) {
  const repo = await createGitFixture();
  cleanups.push(repo.cleanup);
  const store = new CoreStore(resolve(repo.root, "..", "core.sqlite"));
  store.initialize();
  cleanups.push(async () => store.close());
  const company = {
    ...companyDefinitionFixture(),
    validation: {
      commands: [{
        id: "integration-check",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: ".",
        timeoutSeconds: 10
      }],
      integrationCommandIds: ["integration-check"]
    }
  };
  store.createCompany({
    id: "company-1",
    definition: company,
    event: event("company.created", null)
  });
  const oldCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  const manager = new WorkspaceManager({ store, companyId: "company-1" });
  await manager.createRun("run-1", {
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit: oldCommit,
    gitCommonDir: resolve(repo.root, ".git"),
    objectIdLength: 40
  });
  const verify = vi.fn(async (record: ReviewPackageRecord) => {
    if (options.evidenceFailure !== undefined) throw options.evidenceFailure;
    return record;
  });
  let approved: GitSubmissionRecord | null = null;
  if (options.preparedAt !== undefined) {
    await repo.write("feature.txt", "candidate\n");
    await repo.git(["add", "feature.txt"]);
    await repo.git(["commit", "-m", "candidate"]);
    const candidateSource = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const tasks = new TaskService(store, "company-1", company, "leader");
    const created = tasks.create({
      id: "task-a",
      title: "Task A",
      objective: "Integrate candidate",
      ownerEmployeeId: null,
      dependencies: [],
      acceptanceCriteria: ["Integrated"],
      status: "draft",
      retryCount: 0,
      reviewLoopCount: 0,
      artifacts: [],
      evidence: [],
      conflictForTaskId: null
    });
    const reviewedEvent = event("task.review_approved", "task-a");
    const reviewed: TaskRecord = {
      ...created,
      ownerEmployeeId: "developer",
      status: "review",
      artifacts: [resolve(repo.root, "manifest.json")],
      evidence: ["c".repeat(64)],
      updatedEventId: reviewedEvent.id
    };
    store.putTask("company-1", reviewed, [reviewedEvent]);
    approved = {
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      submission: submission(candidateSource),
      status: "approved",
      supersedes: null
    };
    store.putGitSubmission(approved);
    store.putReviewPackage({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      manifestPath: resolve(repo.root, "manifest.json"),
      manifestHash: "c".repeat(64),
      totalBytes: 1,
      status: "created"
    });
    store.putReviewDecision({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      decision: {
        schemaVersion: 1,
        decision: "approve",
        findings: [],
        coverageGaps: [],
        summary: "Ready",
        reviewedManifestHash: "c".repeat(64)
      }
    });
    const service = new IntegrationService({
      store,
      companyId: "company-1",
      company,
      runId: "run-1",
      workspaceManager: manager,
      validationRunner: new ValidationRunner({ store, companyId: "company-1", company }),
      faultHooks: options.preparedAt === "old"
        ? { afterPrepared: () => { throw new Error("crash after prepare"); } }
        : { afterRefUpdated: () => { throw new Error("crash after CAS"); } }
    });
    await expect(service.integrate(approved)).rejects.toThrow(/crash after/u);
  }
  const reconciler = new GitReconciler({
    store,
    companyId: "company-1",
    workspaceManager: manager,
    evidenceBuilder: { verify }
  });
  return { approved, company, manager, oldCommit, reconciler, repo, store, verify };
}

async function ref(repo: GitFixture, name: string): Promise<string> {
  return (await repo.git(["rev-parse", name])).stdout.trim();
}

describe("GitReconciler", () => {
  it("verifies an unchanged paused run", async () => {
    const harness = await setup();
    await harness.manager.pauseRun("run-1");

    await expect(harness.reconciler.reconcile("run-1")).resolves.toEqual({
      runId: "run-1",
      classification: "verified",
      discrepancies: []
    });
  });

  it("snapshots durable Git checkpoint facts without optional omissions", async () => {
    const harness = await setup({ preparedAt: "old" });
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;

    await expect(harness.reconciler.snapshot("run-1")).resolves.toEqual({
      runId: "run-1",
      integrationRef: "refs/heads/agenttown/run-1/integration",
      integrationCommit: harness.oldCommit,
      workspaces: expect.arrayContaining([
        expect.objectContaining({
          workspaceId: "run-1:integration",
          headCommit: harness.oldCommit,
          status: "active"
        })
      ]),
      activeSubmissionRevisions: [{ taskId: "task-a", revision: 1 }],
      integrationAttemptIds: [attempt.attemptId]
    });
  });

  it("refuses to snapshot externally changed Git facts", async () => {
    const harness = await setup();
    await harness.repo.write("third.txt", "third\n");
    await harness.repo.git(["add", "third.txt"]);
    await harness.repo.git(["commit", "-m", "third"]);
    await harness.repo.git([
      "update-ref",
      "refs/heads/agenttown/run-1/integration",
      await ref(harness.repo, "HEAD")
    ]);

    await expect(harness.reconciler.snapshot("run-1"))
      .rejects.toThrow("integration ref changed");
  });

  it("classifies a missing formal ref as missing", async () => {
    const harness = await setup();
    await harness.repo.git([
      "update-ref",
      "-d",
      "refs/heads/agenttown/run-1/integration",
      harness.oldCommit
    ]);

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("missing");
    expect(result.discrepancies).toEqual([{
      kind: "integration_ref",
      expected: harness.oldCommit,
      actual: null
    }]);
  });

  it("classifies a missing durable commit object as missing", async () => {
    const harness = await setup();
    harness.store.putGitRun({
      ...harness.store.getGitRun("run-1")!,
      baseCommit: "f".repeat(40)
    });

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("missing");
    expect(result.discrepancies).toEqual([{
      kind: "commit",
      expected: "f".repeat(40),
      actual: null
    }]);
  });

  it("classifies missing evidence separately from manifest tampering", async () => {
    const harness = await setup({
      evidenceFailure: new Error("missing: review evidence directory not found")
    });
    harness.store.putReviewPackage({
      runId: "run-1",
      taskId: "task-a",
      revision: 1,
      manifestPath: resolve(harness.repo.root, "missing", "manifest.json"),
      manifestHash: "c".repeat(64),
      totalBytes: 1,
      status: "created"
    });

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("missing");
    expect(result.discrepancies[0]?.kind).toBe("evidence:task-a:1");
  });


  it("completes strict final facts when a prepared attempt ref is at new SHA", async () => {
    const harness = await setup({ preparedAt: "new" });
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("completed_recovery");
    expect(harness.store.getIntegrationAttempt(attempt.attemptId)?.status)
      .toBe("committed");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("integrated");
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("completed");
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(attempt.candidateCommit);
    expect(harness.verify).toHaveBeenCalled();
  });

  it("rolls back a prepared attempt whose ref remains at old SHA", async () => {
    const harness = await setup({ preparedAt: "old" });
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("rolled_back_recovery");
    expect(harness.store.getIntegrationAttempt(attempt.attemptId)?.status).toBe("aborted");
    expect(await ref(harness.repo, "refs/heads/agenttown/run-1/integration"))
      .toBe(harness.oldCommit);
  });

  it("warns when only the original user worktree changed", async () => {
    const harness = await setup();
    await harness.repo.write("user.txt", "user work\n");

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("user_workspace_changed");
    expect(harness.store.getCompany("company-1")?.status).not.toBe("paused");
  });

  it.each(["unknown-ref", "missing-worktree", "changed-task-head", "changed-manifest"])(
    "atomically stops on %s without guessing completion",
    async (scenario) => {
      const harness = await setup({
        ...(scenario === "unknown-ref" ? { preparedAt: "new" as const } : {}),
        ...(scenario === "changed-manifest"
          ? { evidenceFailure: new Error("tampered: manifest hash changed") }
          : {})
      });
      if (scenario === "unknown-ref") {
        await harness.repo.write("third.txt", "third\n");
        await harness.repo.git(["add", "third.txt"]);
        await harness.repo.git(["commit", "-m", "third"]);
        const third = await ref(harness.repo, "HEAD");
        await harness.repo.git([
          "update-ref",
          "refs/heads/agenttown/run-1/integration",
          third
        ]);
      } else if (scenario === "missing-worktree") {
        const integration = harness.store.getGitWorkspace("run-1:integration")!;
        await harness.repo.git(["worktree", "remove", "--", integration.path]);
      } else if (scenario === "changed-task-head") {
        const workspace = await harness.manager.createTaskWorkspace({
          runId: "run-1",
          employeeId: "developer",
          taskId: "task-a",
          baseCommit: harness.oldCommit
        });
        await harness.repo.write("other.txt", "other\n");
        await harness.repo.git(["add", "other.txt"]);
        await harness.repo.git(["commit", "-m", "other"]);
        await harness.repo.git(["update-ref", workspace.branchRef, await ref(harness.repo, "HEAD")]);
      } else {
        harness.store.putReviewPackage({
          runId: "run-1",
          taskId: "task-a",
          revision: 1,
          manifestPath: resolve(harness.repo.root, "manifest.json"),
          manifestHash: "c".repeat(64),
          totalBytes: 1,
          status: "created"
        });
      }

      const result = await harness.reconciler.reconcile("run-1");

      expect(result.classification).toMatch(/tampered|missing/u);
      expect(result.discrepancies.length).toBeGreaterThan(0);
      expect(harness.store.getCompany("company-1")?.status).toBe("paused");
      const approval = harness.store.listPendingApprovals("company-1").at(-1);
      expect(approval?.request).toEqual({
        reason: "git_reconciliation_stop",
        runId: "run-1",
        classification: result.classification,
        discrepancies: result.discrepancies
      });
      const detected = harness.store.listEvents(0).find(
        ({ type }) => type === "git.tampering_detected"
      );
      expect(detected?.payload).toEqual({
        runId: "run-1",
        classification: result.classification,
        discrepancies: result.discrepancies
      });
    }
  );
});
