import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CompanyDefinition,
  GitSubmissionRecord,
  GitTaskSubmission,
  IntegrationAttemptRecord,
  TaskRecord
} from "@agenttown/runtime-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitCommandRunner } from "../src/git/git-command.js";
import { GitWorkflowCoordinator } from "../src/git/git-workflow-coordinator.js";
import { CoreStore } from "../src/storage/core-store.js";
import { TaskService } from "../src/tasks/task-service.js";
import {
  IntegrationService,
  type IntegrationFaultHooks,
  orderIntegrations
} from "../src/git/integration-service.js";
import { ValidationRunner } from "../src/git/validation-runner.js";
import { WorkspaceManager } from "../src/git/workspace-manager.js";
import {
  companyDefinitionFixture,
  createTemporaryProject
} from "./helpers.js";
import {
  createGitFixture,
  type GitFixture
} from "./helpers/git-fixture.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function submission(head = "b".repeat(40)): GitTaskSubmission {
  return {
    schemaVersion: 1,
    headCommit: head,
    commits: [head],
    changeSummary: "Reviewed change",
    validationCommandIds: [],
    suggestedValidationCommands: [],
    reportedResults: [],
    knownRisks: []
  };
}

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

async function queueHarness() {
  const project = await createTemporaryProject();
  cleanups.push(project.cleanup);
  const store = new CoreStore(project.databasePath);
  store.initialize();
  cleanups.push(async () => store.close());
  const company = companyDefinitionFixture();
  store.createCompany({
    id: "company-1",
    definition: company,
    event: event("company.created", null)
  });
  const now = "2026-07-30T00:00:00.000Z";
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: project.root,
    originalBranch: "main",
    baseCommit: "a".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "a".repeat(40),
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  store.putGitWorkspace({
    workspaceId: "run-1:integration",
    runId: "run-1",
    taskId: null,
    employeeId: null,
    kind: "integration",
    path: `${project.root}\\integration`,
    branchRef: "refs/heads/agenttown/run-1/integration",
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    status: "active"
  });
  const tasks = new TaskService(store, "company-1", company, "leader");
  const createTask = (id: string, dependencies: string[] = []) => tasks.create({
    id,
    title: id,
    objective: `Complete ${id}`,
    ownerEmployeeId: null,
    dependencies,
    acceptanceCriteria: ["Integrated"],
    status: "draft",
    retryCount: 0,
    reviewLoopCount: 0,
    artifacts: [],
    evidence: [],
    conflictForTaskId: null
  });
  const approve = (task: TaskRecord): GitSubmissionRecord => {
    const reviewed: TaskRecord = {
      ...task,
      ownerEmployeeId: "developer",
      status: "review",
      updatedEventId: randomUUID()
    };
    store.putTask("company-1", reviewed, [{
      ...event("task.review_approved", task.id),
      id: reviewed.updatedEventId
    }]);
    const approved: GitSubmissionRecord = {
      runId: "run-1",
      taskId: task.id,
      revision: 1,
      submission: submission(),
      status: "approved",
      supersedes: null
    };
    store.putGitSubmission(approved);
    store.putReviewPackage({
      runId: "run-1",
      taskId: task.id,
      revision: 1,
      manifestPath: `${project.root}\\${task.id}-manifest.json`,
      manifestHash: "c".repeat(64),
      totalBytes: 1,
      status: "created"
    });
    store.putReviewDecision({
      runId: "run-1",
      taskId: task.id,
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
    return approved;
  };
  const service = new IntegrationService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: {
      createCandidateWorkspace: async () => {
        throw new Error("candidate creation must not be reached");
      },
      removeVerifiedWorkspace: async () => undefined
    },
    validationRunner: {
      run: async () => {
        throw new Error("validation must not be reached");
      }
    }
  });
  return { approve, createTask, service, store };
}

interface RealHarnessOptions {
  conflict?: boolean;
  validationFails?: boolean;
  validationScripts?: string[];
  faultHooks?: IntegrationFaultHooks;
}

async function realHarness(
  options: RealHarnessOptions = {}
): Promise<{
  approved: GitSubmissionRecord;
  company: CompanyDefinition;
  integrationWorkspaceId: string;
  manager: WorkspaceManager;
  oldCommit: string;
  repo: GitFixture;
  service: IntegrationService;
  store: CoreStore;
  validationRunner: ValidationRunner;
}> {
  const repo = await createGitFixture();
  cleanups.push(repo.cleanup);
  const store = new CoreStore(resolve(repo.root, "core.sqlite"));
  store.initialize();
  cleanups.push(async () => store.close());
  const validationScripts = options.validationScripts ?? [
    options.validationFails === true
      ? "process.exit(17)"
      : "process.exit(0)"
  ];
  const commands = validationScripts.map((script, index) => ({
    id: validationScripts.length === 1
      ? "integration-check"
      : `integration-check-${index + 1}`,
    executable: process.execPath,
    args: ["-e", script],
    cwd: ".",
    timeoutSeconds: 10
  }));
  const company: CompanyDefinition = {
    ...companyDefinitionFixture(),
    validation: {
      commands,
      integrationCommandIds: commands.map(({ id }) => id)
    }
  };
  store.createCompany({
    id: "company-1",
    definition: company,
    event: event("company.created", null)
  });

  let candidateCommit: string;
  if (options.conflict === true) {
    await repo.write("shared.txt", "base\n");
    await repo.git(["add", "shared.txt"]);
    await repo.git(["commit", "-m", "shared base"]);
    await repo.git(["checkout", "-b", "candidate-source"]);
    await repo.write("shared.txt", "candidate\n");
    await repo.git(["commit", "-am", "candidate change"]);
    candidateCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
    await repo.git(["checkout", "main"]);
    await repo.write("shared.txt", "formal\n");
    await repo.git(["commit", "-am", "formal change"]);
  }

  const oldCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  const manager = new WorkspaceManager({
    store,
    companyId: "company-1"
  });
  await manager.createRun("run-1", {
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit: oldCommit,
    gitCommonDir: resolve(repo.root, ".git"),
    objectIdLength: 40
  });
  if (options.conflict !== true) {
    await repo.write("feature.txt", "candidate\n");
    await repo.git(["add", "feature.txt"]);
    await repo.git(["commit", "-m", "candidate change"]);
    candidateCommit = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  }

  const tasks = new TaskService(store, "company-1", company, "leader");
  const created = tasks.create({
    id: "task-a",
    title: "Task A",
    objective: "Integrate reviewed candidate",
    ownerEmployeeId: null,
    dependencies: [],
    acceptanceCriteria: ["Integration validation passes"],
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
    artifacts: ["manifest.json"],
    evidence: ["c".repeat(64)],
    updatedEventId: reviewedEvent.id
  };
  store.putTask("company-1", reviewed, [reviewedEvent]);
  const approved: GitSubmissionRecord = {
    runId: "run-1",
    taskId: "task-a",
    revision: 1,
    submission: submission(candidateCommit!),
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
  const validationRunner = new ValidationRunner({
    store,
    companyId: "company-1",
    company
  });
  const service = new IntegrationService({
    store,
    companyId: "company-1",
    company,
    runId: "run-1",
    workspaceManager: manager,
    validationRunner,
    ...(options.faultHooks === undefined
      ? {}
      : { faultHooks: options.faultHooks })
  });
  return {
    approved,
    company,
    integrationWorkspaceId: "run-1:integration",
    manager,
    oldCommit,
    repo,
    service,
    store,
    validationRunner
  };
}

function replayService(
  harness: Awaited<ReturnType<typeof realHarness>>
): {
  assertNoMutationCalls(): void;
  service: IntegrationService;
} {
  const calls = {
    createCandidate: 0,
    git: 0,
    removeCandidate: 0,
    validation: 0
  };
  const service = new IntegrationService({
    store: harness.store,
    companyId: "company-1",
    company: harness.company,
    runId: "run-1",
    workspaceManager: {
      createCandidateWorkspace: async () => {
        calls.createCandidate += 1;
        throw new Error("replay must not create a candidate");
      },
      removeVerifiedWorkspace: async () => {
        calls.removeCandidate += 1;
        throw new Error("replay must not remove a candidate");
      }
    },
    validationRunner: {
      run: async () => {
        calls.validation += 1;
        throw new Error("replay must not run validation");
      }
    },
    git: {
      run: async () => {
        calls.git += 1;
        throw new Error("replay must not run Git");
      }
    }
  });
  return {
    assertNoMutationCalls: () => {
      expect(calls).toEqual({
        createCandidate: 0,
        git: 0,
        removeCandidate: 0,
        validation: 0
      });
    },
    service
  };
}

async function formalRef(
  harness: Awaited<ReturnType<typeof realHarness>>
): Promise<string> {
  return (await harness.repo.git([
    "rev-parse",
    "refs/heads/agenttown/run-1/integration"
  ])).stdout.trim();
}

async function expectReplayIsStable(
  harness: Awaited<ReturnType<typeof realHarness>>,
  expected: object,
  options: { drain?: boolean } = { drain: true }
): Promise<void> {
  const beforeAttempts = harness.store.listIntegrationAttempts("run-1");
  const beforeValidationCount = harness.store
    .listValidationRuns("run-1", "task-a").length;
  const beforeRef = await formalRef(harness);
  const replay = replayService(harness);

  await expect(replay.service.integrate(harness.approved)).resolves.toEqual(
    expected
  );
  if (options.drain !== false) {
    await expect(replay.service.drain()).resolves.toEqual(expected);
  }

  expect(harness.store.listIntegrationAttempts("run-1"))
    .toEqual(beforeAttempts);
  expect(harness.store.listValidationRuns("run-1", "task-a"))
    .toHaveLength(beforeValidationCount);
  expect(await formalRef(harness)).toBe(beforeRef);
  replay.assertNoMutationCalls();
}

describe("IntegrationService", () => {
  it("orders ready submissions by DAG layer, creation sequence, then task id", () => {
    expect(orderIntegrations([
      { taskId: "task-b", layer: 0, createdSequence: 12 },
      { taskId: "task-a", layer: 0, createdSequence: 11 },
      { taskId: "task-c", layer: 1, createdSequence: 5 }
    ]).map(({ taskId }) => taskId)).toEqual([
      "task-a",
      "task-b",
      "task-c"
    ]);
  });

  it("waits for an earlier same-layer task that is not approved", async () => {
    const harness = await queueHarness();
    harness.createTask("task-a");
    const approvedB = harness.approve(harness.createTask("task-b"));

    await harness.service.enqueue(approvedB);

    await expect(harness.service.drain()).resolves.toEqual({
      kind: "waiting",
      taskId: "task-a"
    });
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
  });

  it("durably and idempotently queues an approved task before a same-layer wait", async () => {
    const harness = await queueHarness();
    harness.createTask("task-a");
    const approvedB = harness.approve(harness.createTask("task-b"));

    await harness.service.enqueue(approvedB);
    await harness.service.enqueue(approvedB);
    const result = await harness.service.drain();

    expect(result).toEqual({ kind: "waiting", taskId: "task-a" });
    expect(harness.store.getGitSubmission("run-1", "task-b", 1)?.status)
      .toBe("queued");
    expect(harness.store.listEvents(0).filter(
      ({ type, taskId }) => type === "integration.queued" && taskId === "task-b"
    )).toHaveLength(1);
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
  });

  it("rejects a persisted dependency cycle before selecting a candidate", async () => {
    const harness = await queueHarness();
    const taskA = harness.createTask("task-a");
    const taskB = harness.createTask("task-b", ["task-a"]);
    harness.store.putTask("company-1", {
      ...taskA,
      dependencies: ["task-b"]
    }, [event("task.dependencies_tampered", "task-a")]);
    const approvedB = harness.approve(taskB);

    await harness.service.enqueue(approvedB);

    await expect(harness.service.drain()).rejects.toThrow("dependency cycle");
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
  });

  it("advances the ref and exact integration worktree only after candidate validation", async () => {
    const harness = await realHarness();
    const throwingListener = vi.fn(() => {
      throw new Error("listener failed");
    });
    harness.store.subscribeEvents(throwingListener);

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("integrated");
    const attempt = (result as {
      kind: "integrated";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt).toMatchObject({
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      status: "committed",
      expectedOldCommit: harness.oldCommit,
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(attempt.candidateCommit).not.toBe(harness.oldCommit);
    expect(attempt.validationRunIds).toHaveLength(1);
    expect(attempt.orderKey).toMatch(
      /^00000000:\d{20}:task-a$/u
    );
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    );
    expect(integration).toMatchObject({
      status: "active",
      headCommit: attempt.candidateCommit
    });
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "symbolic-ref",
      "HEAD"
    ])).stdout.trim()).toBe(
      "refs/heads/agenttown/run-1/integration"
    );
    expect((await harness.repo.git([
      "-C",
      integration!.path,
      "status",
      "--porcelain=v2",
      "--untracked-files=all"
    ])).stdout).toBe("");
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(attempt.candidateCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status)
      .toBe("completed");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("integrated");
    expect(harness.store.getGitWorkspace(
      `run-1:candidate:${attempt.attemptId}`
    )?.status).toBe("missing");
    expect((await harness.repo.git([
      "rev-parse",
      "--verify",
      "--quiet",
      attempt.candidateRef
    ], [0, 1])).exitCode).toBe(1);
    expect(throwingListener).toHaveBeenCalled();
    await expectReplayIsStable(harness, {
      kind: "integrated",
      attempt
    }, { drain: false });
    harness.store.putGitWorkspace({
      ...integration!,
      headCommit: harness.oldCommit
    });
    const staleReplay = replayService(harness);
    await expect(staleReplay.service.integrate(harness.approved))
      .rejects.toThrow("committed integration facts");
    staleReplay.assertNoMutationCalls();
    harness.store.putGitWorkspace(integration!);

    const committedEvent = harness.store.listEvents(0).find(
      ({ type, taskId }) =>
        type === "git.integration.committed" && taskId === "task-a"
    )!;
    const duplicateCommittedId = randomUUID();
    harness.store.insertEvent({
      id: duplicateCommittedId,
      type: committedEvent.type,
      actorId: committedEvent.actorId,
      taskId: committedEvent.taskId,
      causationEventId: committedEvent.causationEventId,
      payload: committedEvent.payload
    });
    const duplicateReplay = replayService(harness);
    await expect(duplicateReplay.service.integrate(harness.approved))
      .rejects.toThrow("committed integration facts");
    duplicateReplay.assertNoMutationCalls();

    const database = new DatabaseSync(resolve(harness.repo.root, "core.sqlite"));
    try {
      database.prepare("DELETE FROM events WHERE id = ?")
        .run(duplicateCommittedId);
      database.prepare(`
        UPDATE events
        SET actor_id = ?, payload_json = ?
        WHERE id = ?
      `).run(
        "attacker",
        JSON.stringify({
          ...committedEvent.payload,
          newCommit: harness.oldCommit
        }),
        committedEvent.id
      );
      const forgedReplay = replayService(harness);
      await expect(forgedReplay.service.integrate(harness.approved))
        .rejects.toThrow("committed integration facts");
      forgedReplay.assertNoMutationCalls();

      database.prepare("DELETE FROM events WHERE id = ?")
        .run(committedEvent.id);
      const missingReplay = replayService(harness);
      await expect(missingReplay.service.integrate(harness.approved))
        .rejects.toThrow("committed integration facts");
      missingReplay.assertNoMutationCalls();
    } finally {
      database.close();
    }
    expect(await formalRef(harness)).toBe(attempt.candidateCommit);
  }, 20_000);

  it("keeps the formal ref and worktree unchanged when candidate validation fails", async () => {
    const harness = await realHarness({ validationFails: true });
    const beforeWorkspace = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("validation_failed");
    const attempt = (result as {
      kind: "validation_failed";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt.status).toBe("validation_failed");
    expect(attempt.validationRunIds).toHaveLength(1);
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect((await harness.repo.git([
      "-C",
      beforeWorkspace.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
    await expectReplayIsStable(harness, {
      kind: "validation_failed",
      attempt
    });
  }, 20_000);

  it("runs every configured integration command even after a non-passed result", async () => {
    const harness = await realHarness({
      validationScripts: ["process.exit(23)", "process.exit(0)"]
    });

    const result = await harness.service.integrate(harness.approved);

    expect(result).toMatchObject({
      kind: "validation_failed",
      attempt: {
        validationRunIds: expect.any(Array)
      }
    });
    expect(harness.store.listValidationRuns("run-1", "task-a")).toHaveLength(2);
    const attempt = (result as {
      kind: "validation_failed";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    expect(attempt.validationRunIds.map((validationId) => {
      const { command, outcome } = harness.store.getValidationRun(validationId)!;
      return [command.id, outcome];
    })).toEqual([
      ["integration-check-1", "failed"],
      ["integration-check-2", "passed"]
    ]);
  }, 20_000);

  it("captures conflicts from the candidate and leaves formal integration unchanged", async () => {
    const harness = await realHarness({ conflict: true });
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("conflicted");
    expect(result).toMatchObject({
      kind: "conflicted",
      files: ["shared.txt"],
      attempt: {
        status: "conflicted",
        conflictFiles: ["shared.txt"]
      }
    });
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    const attempt = (result as {
      kind: "conflicted";
      attempt: IntegrationAttemptRecord;
    }).attempt;
    await expectReplayIsStable(harness, {
      kind: "conflicted",
      attempt,
      files: ["shared.txt"]
    });
  }, 20_000);

  it("does not retry a compare-and-swap mismatch and leaves a prepared recovery intent", async () => {
    const harness = await realHarness();
    const baseGit = new GitCommandRunner();
    let casCalls = 0;
    const service = new IntegrationService({
      store: harness.store,
      companyId: "company-1",
      company: harness.company,
      runId: "run-1",
      workspaceManager: harness.manager,
      validationRunner: harness.validationRunner,
      git: {
        run: async (args, commandOptions) => {
          if (args[0] === "update-ref"
            && args[1] === "refs/heads/agenttown/run-1/integration") {
            casCalls += 1;
            await harness.repo.git([
              "update-ref",
              "refs/heads/agenttown/run-1/integration",
              harness.approved.submission.headCommit,
              harness.oldCommit
            ]);
          }
          return await baseGit.run(args, commandOptions);
        }
      }
    });

    const result = await service.integrate(harness.approved);

    expect(result.kind).toBe("reconciliation_required");
    expect(casCalls).toBe(1);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt).toMatchObject({
      status: "prepared",
      expectedOldCommit: harness.oldCommit,
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
    const aborted = {
      ...attempt,
      status: "aborted" as const
    };
    harness.store.commitIntegrationAttemptOutcome({
      attempt: aborted,
      event: event("git.integration.aborted", attempt.taskId)
    });
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
  }, 20_000);

  it("fails closed for mismatched or duplicate exact attempts", async () => {
    const stop = new Error("afterPrepared crash");
    let harness!: Awaited<ReturnType<typeof realHarness>>;
    harness = await realHarness({
      faultHooks: { afterPrepared: () => { throw stop; } }
    });
    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    const mismatched = {
      ...attempt,
      expectedOldCommit: "f".repeat(40)
    };
    harness.store.putIntegrationAttempt(mismatched);
    const mismatchedReplay = replayService(harness);

    await expect(mismatchedReplay.service.integrate(harness.approved))
      .rejects.toThrow("attempt facts do not match");
    mismatchedReplay.assertNoMutationCalls();

    harness.store.putIntegrationAttempt(attempt);
    harness.store.putIntegrationAttempt({
      ...attempt,
      attemptId: "attempt-duplicate",
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-duplicate"
    });
    const duplicateReplay = replayService(harness);
    await expect(duplicateReplay.service.integrate(harness.approved))
      .rejects.toThrow("attempt identity is not unique");
    await expect(duplicateReplay.service.drain())
      .rejects.toThrow("attempt identity is not unique");
    expect(harness.store.listIntegrationAttempts("run-1")).toHaveLength(2);
    duplicateReplay.assertNoMutationCalls();
  }, 20_000);

  it("rolls back every SQLite fact when the final fact transaction fails", async () => {
    const harness = await realHarness();
    const commit = harness.store.commitIntegratedTask.bind(harness.store);
    vi.spyOn(harness.store, "commitIntegratedTask").mockImplementation((input) => {
      commit({
        ...input,
        events: [
          ...input.events,
          { ...input.events[0]!, type: "duplicate.event" }
        ]
      });
    });

    const result = await harness.service.integrate(harness.approved);

    expect(result.kind).toBe("reconciliation_required");
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt.status).toBe("prepared");
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
    expect(harness.store.getTask("company-1", "task-a")?.status).toBe("review");
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )?.headCommit).toBe(harness.oldCommit);
    expect(harness.store.listEvents(0).some(
      ({ type }) => type === "git.integration.committed"
        || type === "task.completed"
    )).toBe(false);
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
  }, 20_000);

  it("persists prepared intent before any candidate mutation and survives afterPrepared", async () => {
    const stop = new Error("afterPrepared crash");
    const harness = await realHarness({
      faultHooks: {
        afterPrepared: () => {
          expect(harness.store.listIntegrationAttempts("run-1")[0]).toMatchObject({
            status: "prepared",
            candidateCommit: null
          });
          expect(harness.store.listGitWorkspaces("run-1").filter(
            ({ kind }) => kind === "candidate"
          )).toEqual([]);
          throw stop;
        }
      }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(harness.oldCommit);
    expect(harness.service.recoverPrepared()).toEqual([{
      kind: "reconciliation_required",
      attemptId: harness.store.listIntegrationAttempts("run-1")[0]!.attemptId
    }]);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
  }, 20_000);

  it("leaves old durable facts and a new ref when afterRefUpdated crashes", async () => {
    const stop = new Error("afterRefUpdated crash");
    let harness!: Awaited<ReturnType<typeof realHarness>>;
    harness = await realHarness({
      faultHooks: { afterRefUpdated: () => { throw stop; } }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    expect(attempt).toMatchObject({
      status: "prepared",
      candidateCommit: expect.stringMatching(/^[0-9a-f]{40}$/u)
    });
    expect((await harness.repo.git([
      "rev-parse",
      "refs/heads/agenttown/run-1/integration"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
  }, 20_000);

  it("leaves exact new Git state and old durable facts when beforeFactsCommitted crashes", async () => {
    const stop = new Error("beforeFactsCommitted crash");
    let harness!: Awaited<ReturnType<typeof realHarness>>;
    harness = await realHarness({
      faultHooks: { beforeFactsCommitted: () => { throw stop; } }
    });

    await expect(harness.service.integrate(harness.approved)).rejects.toBe(stop);
    const attempt = harness.store.listIntegrationAttempts("run-1")[0]!;
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;
    expect(attempt.status).toBe("prepared");
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "rev-parse",
      "HEAD"
    ])).stdout.trim()).toBe(attempt.candidateCommit);
    expect((await harness.repo.git([
      "-C",
      integration.path,
      "symbolic-ref",
      "HEAD"
    ])).stdout.trim()).toBe(
      "refs/heads/agenttown/run-1/integration"
    );
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(integration.headCommit).toBe(harness.oldCommit);
    await expectReplayIsStable(harness, {
      kind: "reconciliation_required",
      attemptId: attempt.attemptId
    });
  }, 20_000);

  it("sets GIT_EDITOR=true for every cherry-pick mutation", async () => {
    const harness = await realHarness();
    const baseGit = new GitCommandRunner();
    let picks = 0;
    const service = new IntegrationService({
      store: harness.store,
      companyId: "company-1",
      company: harness.company,
      runId: "run-1",
      workspaceManager: harness.manager,
      validationRunner: harness.validationRunner,
      git: {
        run: async (args, commandOptions) => {
          if (args[0] === "cherry-pick") {
            picks += 1;
            expect(commandOptions.gitEditor).toBe(true);
          }
          return await baseGit.run(args, commandOptions);
        }
      }
    });

    await expect(service.integrate(harness.approved)).resolves.toMatchObject({
      kind: "integrated"
    });
    expect(picks).toBe(1);
  }, 20_000);

  it("rejects stale or foreign facts before preparing or mutating a candidate", async () => {
    const harness = await realHarness();
    await expect(harness.service.enqueue({
      ...harness.approved,
      runId: "run-foreign"
    })).rejects.toThrow("not approved for this run");
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;
    harness.store.putGitWorkspace({
      ...integration,
      headCommit: harness.approved.submission.headCommit
    });

    await expect(harness.service.integrate(harness.approved))
      .rejects.toThrow("workspace head is stale");
    expect(harness.store.listIntegrationAttempts("run-1")).toEqual([]);
    expect(harness.store.listGitWorkspaces("run-1").filter(
      ({ kind }) => kind === "candidate"
    )).toEqual([]);
  }, 20_000);

  it("rejects an omitted strict prepared identity bundle without mutating any fact", async () => {
    const harness = await realHarness();
    const attempt: IntegrationAttemptRecord = {
      attemptId: "attempt-omitted",
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      orderKey: "00000000:00000000000000000001:task-a",
      expectedOldCommit: harness.oldCommit,
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-omitted",
      candidateCommit: null,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    const queued: GitSubmissionRecord = {
      ...harness.approved,
      status: "queued"
    };
    const preparedEvent = event("git.integration.prepared", "task-a");
    const unsafeCall = harness.store.commitPreparedIntegration.bind(
      harness.store
    ) as unknown as (input: {
      attempt: IntegrationAttemptRecord;
      submission: GitSubmissionRecord;
      event: ReturnType<typeof event>;
    }) => void;

    expect(() => unsafeCall({
      attempt,
      submission: queued,
      event: preparedEvent
    })).toThrow("strict");

    expect(harness.store.getIntegrationAttempt(attempt.attemptId)).toBeNull();
    expect(harness.store.getGitSubmission("run-1", "task-a", 1))
      .toEqual(harness.approved);
    expect(harness.store.listEvents(0).some(
      ({ id }) => id === preparedEvent.id
    )).toBe(false);
  }, 20_000);

  it("rejects forged supersession at queue and prepared bundle boundaries", async () => {
    const harness = await realHarness();
    const forged = {
      taskId: "original-task",
      revision: 1,
      attemptId: "attempt-original"
    };
    expect(() => harness.store.commitQueuedIntegration({
      companyId: "company-1",
      submission: { ...harness.approved, status: "queued", supersedes: forged },
      event: {
        ...event("integration.queued", "task-a"),
        payload: { runId: "run-1", revision: 1 }
      }
    })).toThrow(/stale|mismatch/u);
    harness.store.commitQueuedIntegration({
      companyId: "company-1",
      submission: { ...harness.approved, status: "queued" },
      event: {
        ...event("integration.queued", "task-a"),
        payload: { runId: "run-1", revision: 1 }
      }
    });
    const attempt: IntegrationAttemptRecord = {
      attemptId: "attempt-supersedes-forged",
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      orderKey: "00000000:00000000000000000001:task-a",
      expectedOldCommit: harness.oldCommit,
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-supersedes-forged",
      candidateCommit: null,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    expect(() => harness.store.commitPreparedIntegration({
      companyId: "company-1",
      attempt,
      submission: { ...harness.approved, status: "queued", supersedes: forged },
      event: event("git.integration.prepared", "task-a")
    })).toThrow(/stale|mismatch/u);
    expect(harness.store.getIntegrationAttempt(attempt.attemptId)).toBeNull();
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.supersedes)
      .toBeNull();
  }, 20_000);

  it("rejects omitted or forged final bundle identities with full transaction rollback", async () => {
    const harness = await realHarness();
    const attempt: IntegrationAttemptRecord = {
      attemptId: "attempt-final",
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      orderKey: "00000000:00000000000000000001:task-a",
      expectedOldCommit: harness.oldCommit,
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-final",
      candidateCommit: null,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    harness.store.commitQueuedIntegration({
      companyId: "company-1",
      submission: { ...harness.approved, status: "queued" },
      event: {
        ...event("integration.queued", "task-a"),
        payload: { runId: "run-1", revision: 1 }
      }
    });
    harness.store.commitPreparedIntegration({
      companyId: "company-1",
      attempt,
      submission: { ...harness.approved, status: "queued" },
      event: event("git.integration.prepared", "task-a")
    });
    const preparedWithCommit: IntegrationAttemptRecord = {
      ...attempt,
      candidateCommit: "d".repeat(40)
    };
    harness.store.putIntegrationAttempt(preparedWithCommit);
    const completedEvent = event("task.completed", "task-a");
    const currentTask = harness.store.getTask("company-1", "task-a")!;
    const completedTask: TaskRecord = {
      ...currentTask,
      status: "completed",
      updatedEventId: completedEvent.id
    };
    const unsafeCall = harness.store.commitIntegratedTask.bind(
      harness.store
    ) as unknown as (input: {
      attempt: IntegrationAttemptRecord;
      submission: GitSubmissionRecord;
      task: TaskRecord;
      events: ReturnType<typeof event>[];
    }) => void;

    expect(() => unsafeCall({
      attempt: { ...preparedWithCommit, status: "committed" },
      submission: { ...harness.approved, status: "integrated" },
      task: completedTask,
      events: [
        event("git.integration.committed", "task-a"),
        completedEvent
      ]
    })).toThrow("strict");

    expect(harness.store.getIntegrationAttempt(attempt.attemptId))
      .toEqual(preparedWithCommit);
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
    expect(harness.store.getTask("company-1", "task-a")).toEqual(currentTask);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
  }, 20_000);

  it("rejects attempt-bound validation in another registered candidate workspace", async () => {
    const harness = await realHarness();
    const attempt: IntegrationAttemptRecord = {
      attemptId: "attempt-owner",
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      orderKey: "00000000:00000000000000000001:task-a",
      expectedOldCommit: harness.oldCommit,
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-owner",
      candidateCommit: harness.oldCommit,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    harness.store.commitQueuedIntegration({
      companyId: "company-1",
      submission: { ...harness.approved, status: "queued" },
      event: {
        ...event("integration.queued", "task-a"),
        payload: { runId: "run-1", revision: 1 }
      }
    });
    harness.store.commitPreparedIntegration({
      companyId: "company-1",
      attempt: { ...attempt, candidateCommit: null },
      submission: { ...harness.approved, status: "queued" },
      event: event("git.integration.prepared", "task-a")
    });
    harness.store.putIntegrationAttempt(attempt);
    await harness.manager.createCandidateWorkspace({
      runId: "run-1",
      attemptId: "attempt-owner",
      baseCommit: harness.oldCommit
    });
    const foreignCandidate = await harness.manager.createCandidateWorkspace({
      runId: "run-1",
      attemptId: "attempt-foreign",
      baseCommit: harness.oldCommit
    });
    const marker = resolve(foreignCandidate.path, "validation-ran.txt");
    const command = {
      id: "cross-candidate",
      executable: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`
      ],
      cwd: ".",
      timeoutSeconds: 10
    };
    harness.store.putValidationCommandGrant({
      grantId: "cross-candidate-grant",
      runId: "run-1",
      taskId: "task-a",
      workspaceId: foreignCandidate.workspaceId,
      command,
      status: "approved",
      decisionReason: "test"
    });

    await expect(harness.validationRunner.run(command, {
      runId: "run-1",
      taskId: "task-a",
      integrationAttemptId: attempt.attemptId,
      workspaceId: foreignCandidate.workspaceId,
      workspaceRoot: foreignCandidate.path
    })).rejects.toThrow("candidate workspace");

    await expect(import("node:fs/promises").then(({ stat }) => stat(marker)))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.store.listValidationRuns("run-1", "task-a")).toEqual([]);
  }, 20_000);

  it("rejects final facts whose validation came from another candidate workspace", async () => {
    const harness = await realHarness();
    const attempt: IntegrationAttemptRecord = {
      attemptId: "attempt-final-owner",
      runId: "run-1",
      taskId: "task-a",
      submissionRevision: 1,
      orderKey: "00000000:00000000000000000001:task-a",
      expectedOldCommit: harness.oldCommit,
      candidateRef: "refs/heads/agenttown/run-1/candidate/attempt-final-owner",
      candidateCommit: null,
      status: "prepared",
      conflictFiles: [],
      validationRunIds: []
    };
    harness.store.commitQueuedIntegration({
      companyId: "company-1",
      submission: { ...harness.approved, status: "queued" },
      event: {
        ...event("integration.queued", "task-a"),
        payload: { runId: "run-1", revision: 1 }
      }
    });
    harness.store.commitPreparedIntegration({
      companyId: "company-1",
      attempt,
      submission: { ...harness.approved, status: "queued" },
      event: event("git.integration.prepared", "task-a")
    });
    await harness.manager.createCandidateWorkspace({
      runId: "run-1",
      attemptId: "attempt-final-owner",
      baseCommit: harness.oldCommit
    });
    const foreignCandidate = await harness.manager.createCandidateWorkspace({
      runId: "run-1",
      attemptId: "attempt-final-foreign",
      baseCommit: harness.oldCommit
    });
    const candidateCommit = "d".repeat(40);
    const validationId = "validation-cross-candidate";
    const preparedWithValidation: IntegrationAttemptRecord = {
      ...attempt,
      candidateCommit,
      validationRunIds: [validationId]
    };
    harness.store.putIntegrationAttempt({
      ...attempt,
      candidateCommit
    });
    harness.store.putValidationRun({
      validationId,
      runId: "run-1",
      taskId: "task-a",
      integrationAttemptId: attempt.attemptId,
      command: harness.company.validation.commands[0]!,
      workspaceId: foreignCandidate.workspaceId,
      outcome: "passed",
      exitCode: 0,
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:01.000Z",
      logPath: resolve(harness.repo.root, "validation.log"),
      logHash: "e".repeat(64)
    });
    harness.store.putIntegrationAttempt(preparedWithValidation);
    const currentTask = harness.store.getTask("company-1", "task-a")!;
    const completedEvent = {
      ...event("task.completed", "task-a"),
      payload: {
        attemptId: attempt.attemptId,
        runId: attempt.runId,
        revision: attempt.submissionRevision,
        integrationCommit: candidateCommit
      }
    };
    const integration = harness.store.getGitWorkspace(
      harness.integrationWorkspaceId
    )!;
    const commitEvent = {
      ...event("git.integration.committed", "task-a"),
      payload: {
        attemptId: attempt.attemptId,
        oldCommit: attempt.expectedOldCommit,
        newCommit: candidateCommit,
        validationRunIds: [validationId]
      }
    };

    expect(() => harness.store.commitIntegratedTask({
      companyId: "company-1",
      attempt: {
        ...preparedWithValidation,
        status: "committed"
      },
      submission: { ...harness.approved, status: "integrated" },
      task: {
        ...currentTask,
        status: "completed",
        updatedEventId: completedEvent.id
      },
      run: {
        ...harness.store.getGitRun("run-1")!,
        integrationCommit: candidateCommit
      },
      integrationWorkspace: {
        ...integration,
        headCommit: candidateCommit
      },
      events: [commitEvent, completedEvent]
    })).toThrow("candidate workspace");

    expect(harness.store.getIntegrationAttempt(attempt.attemptId))
      .toEqual(preparedWithValidation);
    expect(harness.store.getGitSubmission("run-1", "task-a", 1)?.status)
      .toBe("queued");
    expect(harness.store.getTask("company-1", "task-a")).toEqual(currentTask);
    expect(harness.store.getGitRun("run-1")?.integrationCommit)
      .toBe(harness.oldCommit);
    expect(harness.store.listEvents(0).some(
      ({ id }) => id === commitEvent.id || id === completedEvent.id
    )).toBe(false);
  }, 20_000);

  it("drains an approved coordinator review through IntegrationService", async () => {
    const harness = await queueHarness();
    const created = harness.createTask("task-a");
    const approved = harness.approve(created);
    const enqueue = vi.fn(async () => undefined);
    const drain = vi.fn(async () => ({ kind: "waiting" as const, taskId: "task-a" }));
    const coordinator = new GitWorkflowCoordinator({
      store: harness.store,
      companyId: "company-1",
      company: companyDefinitionFixture(),
      runId: "run-1",
      tasks: new TaskService(
        harness.store,
        "company-1",
        companyDefinitionFixture(),
        "leader"
      ),
      workspaceManager: {
        createTaskWorkspace: async () => {
          throw new Error("not reached");
        }
      },
      submissionValidator: {
        validate: async () => {
          throw new Error("not reached");
        }
      },
      validationRunner: {
        requestGrant: async () => {
          throw new Error("not reached");
        },
        run: async () => {
          throw new Error("not reached");
        }
      },
      evidenceBuilder: {
        create: async () => {
          throw new Error("not reached");
        },
        verify: async (record) => record
      },
      reviewService: {
        recordDecision: async () => ({
          kind: "approved",
          submission: approved
        })
      },
      integrationService: { enqueue, drain },
      reviewerIds: new Set(["reviewer"]),
      sendMessage: async () => undefined
    });

    await coordinator.recordReview({
      schemaVersion: 1,
      actionId: randomUUID(),
      type: "task.approve",
      actorEmployeeId: "reviewer",
      taskId: "task-a",
      payload: {
        revision: 1,
        decision: {
          schemaVersion: 1,
          decision: "approve",
          findings: [],
          coverageGaps: [],
          summary: "Ready",
          reviewedManifestHash: "c".repeat(64)
        }
      },
      reason: "Reviewed immutable evidence",
      causationEventId: null
    });

    expect(enqueue).toHaveBeenCalledWith(approved);
    expect(drain).toHaveBeenCalledOnce();
  });
});
