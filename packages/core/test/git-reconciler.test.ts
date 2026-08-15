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
import { GitCommandRunner } from "../src/git/git-command.js";
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
  preparedAt?: "old" | "before-cas" | "new";
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
    const baseGit = new GitCommandRunner();
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
      ,...(options.preparedAt === "before-cas" ? {
        git: {
          run: async (args, gitOptions) =>
            args[0] === "update-ref" && args[1] === "refs/heads/agenttown/run-1/integration"
              ? { stdout: "", stderr: "CAS blocked", exitCode: 1 }
              : baseGit.run(args, gitOptions)
        }
      } : {})
    });
    if (options.preparedAt === "before-cas") {
      await expect(service.integrate(approved)).resolves.toMatchObject({
        kind: "reconciliation_required"
      });
    } else {
      await expect(service.integrate(approved)).rejects.toThrow(/crash after/u);
    }
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

  it("replays the same pending reconciliation episode without duplicate approval or event", async () => {
    const harness = await setup();
    await harness.repo.git([
      "update-ref", "-d", "refs/heads/agenttown/run-1/integration", harness.oldCommit
    ]);

    const first = await harness.reconciler.reconcile("run-1");
    const beforeApprovals = harness.store.listPendingApprovals("company-1");
    const beforeEvents = harness.store.listEvents(0).filter(
      ({ type }) => type === "git.tampering_detected"
    );
    const second = await harness.reconciler.reconcile("run-1");

    expect(second).toEqual(first);
    expect(harness.store.listPendingApprovals("company-1")).toEqual(beforeApprovals);
    expect(harness.store.listEvents(0).filter(
      ({ type }) => type === "git.tampering_detected"
    )).toEqual(beforeEvents);
  });

  it("creates a distinct approval episode when exact discrepancies change", async () => {
    const harness = await setup();
    await harness.repo.git([
      "update-ref", "-d", "refs/heads/agenttown/run-1/integration", harness.oldCommit
    ]);
    await harness.reconciler.reconcile("run-1");
    const first = harness.store.listPendingApprovals("company-1")[0]!;
    await harness.repo.write("third.txt", "third\n");
    await harness.repo.git(["add", "third.txt"]);
    await harness.repo.git(["commit", "-m", "third"]);
    await harness.repo.git([
      "update-ref", "refs/heads/agenttown/run-1/integration", await ref(harness.repo, "HEAD")
    ]);

    await harness.reconciler.reconcile("run-1");

    const approvals = harness.store.listPendingApprovals("company-1");
    expect(approvals).toHaveLength(2);
    expect(approvals[1]?.id).not.toBe(first.id);
  });

  it("creates a new approval episode after the previous exact episode was decided", async () => {
    const harness = await setup();
    await harness.repo.git([
      "update-ref", "-d", "refs/heads/agenttown/run-1/integration", harness.oldCommit
    ]);
    await harness.reconciler.reconcile("run-1");
    const first = harness.store.listPendingApprovals("company-1")[0]!;
    const detected = harness.store.listEvents(0).find((event) =>
      event.type === "git.tampering_detected" && event.payload.approvalId === first.id
    )!;
    const decidedAt = new Date().toISOString();
    harness.store.commitApprovalDecision({
      approval: {
        ...first,
        status: "rejected",
        decision: { choice: "keep_blocked" },
        decidedAt
      },
      event: {
        id: "approval-decision-1",
        type: "user.approval.decided",
        actorId: "owner",
        taskId: null,
        causationEventId: detected.id,
        payload: {
          approvalId: first.id,
          status: "rejected",
          decision: { choice: "keep_blocked" }
        }
      }
    });

    await harness.reconciler.reconcile("run-1");

    const pending = harness.store.listPendingApprovals("company-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(first.id);
    expect(harness.store.getApproval(first.id)?.status).toBe("rejected");
    expect(harness.store.listEvents(0).filter(
      ({ type }) => type === "git.tampering_detected"
    )).toHaveLength(2);
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

  it("rolls back a prepared attempt whose paused candidate still matches", async () => {
    // A checkpoint pause can land while an integration is prepared: pauseRun
    // sets the run and every active workspace to paused, and restart
    // reconciliation must recover the prepared attempt (roll back) instead of
    // flagging the untouched paused candidate as tampered.
    const harness = await setup({ preparedAt: "before-cas" });
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    const candidate = harness.store.listGitWorkspaces("run-1")
      .find(({ kind }) => kind === "candidate")!;
    // The before-cas fault hook also detached the integration worktree; restore
    // the formal integration workspace to its attached state so only the
    // candidate pause (the real pause-time state) is under test.
    const integration = harness.store.listGitWorkspaces("run-1")
      .find(({ kind }) => kind === "integration")!;
    await harness.repo.git([
      "-C", integration.path,
      "checkout", "--detach", harness.oldCommit
    ]);
    await harness.repo.git([
      "-C", integration.path,
      "symbolic-ref", "HEAD", "refs/heads/agenttown/run-1/integration"
    ]);
    harness.store.putGitWorkspace({
      ...integration,
      headCommit: harness.oldCommit,
      branchRef: "refs/heads/agenttown/run-1/integration",
      status: "active"
    });
    await harness.manager.pauseRun("run-1");
    expect(harness.store.getGitWorkspace(candidate.workspaceId)?.status).toBe("paused");

    const result = await harness.reconciler.reconcile("run-1");

    expect(result.classification).toBe("rolled_back_recovery");
    expect(harness.store.getIntegrationAttempt(attempt.attemptId)?.status).toBe("aborted");
    expect(await ref(harness.repo, "refs/heads/agenttown/run-1/integration"))
      .toBe(harness.oldCommit);
  }, 20_000);

  it.each([
    "missing-path",
    "missing-ref",
    "changed-head",
    "candidate-mismatch",
    "changed-record-path",
    "changed-record-ref"
  ])(
    "stops instead of aborting an old-SHA candidate with %s",
    async (scenario) => {
      const harness = await setup({ preparedAt: "before-cas" });
      const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
      const candidate = harness.store.listGitWorkspaces("run-1")
        .find(({ kind }) => kind === "candidate")!;
      const remove = vi.spyOn(harness.manager, "removeVerifiedWorkspace");
      if (scenario === "missing-path") {
        await harness.repo.git(["worktree", "remove", "--", candidate.path]);
      } else if (scenario === "missing-ref") {
        await harness.repo.git(["update-ref", "-d", candidate.branchRef, candidate.headCommit]);
      } else if (scenario === "changed-head") {
        await harness.repo.write("third.txt", "third\n");
        await harness.repo.git(["add", "third.txt"]);
        await harness.repo.git(["commit", "-m", "third"]);
        await harness.repo.git(["update-ref", candidate.branchRef, await ref(harness.repo, "HEAD")]);
      } else if (scenario === "candidate-mismatch") {
        harness.store.putIntegrationAttempt({
          ...attempt,
          candidateCommit: harness.oldCommit
        });
      } else if (scenario === "changed-record-path") {
        harness.store.putGitWorkspace({
          ...candidate,
          path: resolve(harness.repo.root, ".agenttown", "worktrees", "run-1", "forged")
        });
      } else if (scenario === "changed-record-ref") {
        harness.store.putGitWorkspace({
          ...candidate,
          branchRef: `${candidate.branchRef}-forged`
        });
      }

      const result = await harness.reconciler.reconcile("run-1");

      expect(result.classification).toMatch(/missing|tampered/u);
      if (scenario.startsWith("changed-record")) {
        expect(result.classification).toBe("tampered");
      }
      expect(harness.store.getIntegrationAttempt(attempt.attemptId)?.status).toBe("prepared");
      expect(harness.store.getCompany("company-1")?.status).toBe("paused");
      expect(remove).not.toHaveBeenCalled();
    }
  );

  it("atomically stops when a verified candidate changes immediately before removal", async () => {
    const harness = await setup({ preparedAt: "before-cas" });
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    const candidate = harness.store.listGitWorkspaces("run-1")
      .find(({ kind }) => kind === "candidate")!;
    const racing = new GitReconciler({
      store: harness.store,
      companyId: "company-1",
      evidenceBuilder: { verify: async (record) => record },
      workspaceManager: {
        removeVerifiedWorkspace: async (workspaceId) => {
          await harness.repo.write("race.txt", "race\n");
          await harness.repo.git(["add", "race.txt"]);
          await harness.repo.git(["commit", "-m", "race"]);
          await harness.repo.git([
            "update-ref",
            candidate.branchRef,
            await ref(harness.repo, "HEAD")
          ]);
          await harness.manager.removeVerifiedWorkspace(workspaceId);
        }
      }
    });

    const result = await racing.reconcile("run-1");

    expect(result.classification).toBe("tampered");
    expect(harness.store.getIntegrationAttempt(attempt.attemptId)?.status).toBe("prepared");
    expect(harness.store.getCompany("company-1")?.status).toBe("paused");
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
        approvalId: approval?.id,
        runId: "run-1",
        classification: result.classification,
        discrepancies: result.discrepancies
      });
    }
  );
});
