import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewPackageRecord } from "@agenttown/runtime-contract";
import {
  CoreStore,
  EvidencePackageBuilder,
  createInjectedEvidencePackageBuilder,
  type EvidencePackageInput,
  type ValidatedSubmission
} from "../src/index.js";
import { companyDefinitionFixture, createTemporaryProject } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
let project: Awaited<ReturnType<typeof createTemporaryProject>>;
let store: CoreStore;
let builder: EvidencePackageBuilder;

class FaultStore extends CoreStore {
  failReviewCommit = true;

  override commitReviewPackageCreation(
    input: Parameters<CoreStore["commitReviewPackageCreation"]>[0]
  ): void {
    if (this.failReviewCommit) throw new Error("injected review commit failure");
    super.commitReviewPackageCreation(input);
  }
}

beforeEach(async () => {
  project = await createTemporaryProject();
  cleanups.push(project.cleanup);
  store = new CoreStore(project.databasePath);
  store.initialize();
  store.createCompany({
    id: "company-1",
    definition: companyDefinitionFixture(),
    event: {
      id: randomUUID(),
      type: "company.created",
      actorId: "owner",
      taskId: null,
      causationEventId: null,
      payload: { companyId: "company-1" }
    }
  });
  store.putGitRun({
    runId: "run-1",
    companyId: "company-1",
    projectRoot: project.root,
    originalBranch: "main",
    baseCommit: "a".repeat(40),
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: "a".repeat(40),
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  });
  store.putGitWorkspace({
    workspaceId: "workspace-1",
    runId: "run-1",
    taskId: "task-1",
    employeeId: "developer",
    kind: "task",
    path: project.root,
    branchRef: "refs/heads/agenttown/run-1/developer/task-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    status: "active"
  });
  builder = new EvidencePackageBuilder({ store, companyId: "company-1" });
});

afterEach(async () => {
  store.close();
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

function validatedInput(overrides: Partial<EvidencePackageInput> = {}): EvidencePackageInput {
  const validated: ValidatedSubmission = {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "workspace-1",
    employeeId: "developer",
    branchRef: "refs/heads/agenttown/run-1/developer/task-1",
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    commits: [{
      id: "b".repeat(40),
      parents: ["a".repeat(40)],
      authorName: "AgentTown Test",
      authorEmail: "agenttown@example.invalid",
      authoredAt: "2026-07-30T00:00:00+00:00",
      committerName: "AgentTown Test",
      committerEmail: "agenttown@example.invalid",
      committedAt: "2026-07-30T00:00:00+00:00",
      subject: "change",
      body: ""
    }],
    files: [{
      path: "change.txt",
      oldPath: null,
      status: "added",
      oldMode: "000000",
      newMode: "100644",
      size: 7,
      sha256: createHash("sha256").update("change\n").digest("hex"),
      binary: false
    }],
    patch: "diff --git a/change.txt b/change.txt\n+change\n",
    patchBytes: 45,
    warnings: [],
    changeSummary: "Implement the requested change",
    knownRisks: [],
    reportedResults: [],
    validations: []
  };
  return {
    ...validated,
    revision: 1,
    generatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides
  };
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("EvidencePackageBuilder", () => {
  it("creates the strict versioned package with hashes for every file", async () => {
    const record = await builder.create(validatedInput());
    const manifest = JSON.parse(await readFile(record.manifestPath, "utf8")) as {
      files: Record<string, { sha256: string; size: number }>;
    };
    const directory = join(record.manifestPath, "..");

    expect(Object.keys(manifest.files)).toEqual([
      "change-summary.md",
      "changes.patch",
      "commits.json",
      "files.json",
      "task.json"
    ]);
    expect((await readdir(directory)).sort()).toEqual([
      "change-summary.md",
      "changes.patch",
      "commits.json",
      "files.json",
      "manifest.json",
      "task.json",
      "validation"
    ]);
    expect(record.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.manifestHash)
      .toBe(createHash("sha256").update(await readFile(record.manifestPath)).digest("hex"));
    expect(store.getReviewPackage("run-1", "task-1", 1)).toEqual(record);
    expect(store.listEvents(0).at(-1)?.type).toBe("review.package.created");
  });

  it("does not overwrite revision one when revision two is created", async () => {
    const first = await builder.create(validatedInput({ revision: 1 }));
    const second = await builder.create(validatedInput({ revision: 2 }));

    expect(first.manifestPath).not.toBe(second.manifestPath);
    expect(await fileExists(first.manifestPath)).toBe(true);
  });

  it("detects a changed package before review", async () => {
    const record = await builder.create(validatedInput());
    await appendFile(record.manifestPath, "tamper");

    await expect(builder.verify(record)).rejects.toThrow("tampered");
    expect(store.getReviewPackage("run-1", "task-1", 1)?.status).toBe("created");
  });

  it("detects changed files and extra package entries", async () => {
    const changed = await builder.create(validatedInput({ revision: 1 }));
    await appendFile(join(changed.manifestPath, "..", "changes.patch"), "tamper");
    await expect(builder.verify(changed)).rejects.toThrow("tampered");

    const extra = await builder.create(validatedInput({ revision: 2 }));
    await writeFile(join(extra.manifestPath, "..", "extra.txt"), "extra");
    await expect(builder.verify(extra)).rejects.toThrow("tampered");
  });

  it("returns the same verified record for an exact durable retry", async () => {
    const first = await builder.create(validatedInput());
    const eventCount = store.listEvents(0).length;

    const second = await builder.create(validatedInput());

    expect(second).toEqual(first);
    expect(store.listEvents(0)).toHaveLength(eventCount);
  });

  it("does not allow the legacy store API to overwrite an immutable package record", async () => {
    const record = await builder.create(validatedInput());

    expect(() => store.putReviewPackage({
      ...record,
      manifestHash: "f".repeat(64)
    })).toThrow(/immutable|exist/u);
    expect(store.getReviewPackage("run-1", "task-1", 1)).toEqual(record);
  });

  it("fails closed when a destination exists without an identical durable record", async () => {
    const destination = join(
      project.root,
      ".agenttown",
      "runs",
      "run-1",
      "reviews",
      "task-1",
      "1"
    );
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "attacker.txt"), "occupied");

    await expect(builder.create(validatedInput())).rejects.toThrow(/tampered|exist/u);
    expect(await readFile(join(destination, "attacker.txt"), "utf8")).toBe("occupied");
  });

  it("fails closed when the destination appears in the final publish window", async () => {
    const destination = join(
      project.root,
      ".agenttown",
      "runs",
      "run-1",
      "reviews",
      "task-1",
      "1"
    );
    const injected = createInjectedEvidencePackageBuilder(
      { store, companyId: "company-1" },
      {
        beforePublish: async () => {
          await mkdir(destination);
        }
      }
    );

    await expect(injected.create(validatedInput())).rejects.toThrow(/tampered|exist/u);
    expect(await fileExists(destination)).toBe(true);
    expect(await readdir(destination)).toEqual([]);
    expect(store.getReviewPackage("run-1", "task-1", 1)).toBeNull();
  });

  it("copies authoritative validation records and exact log bytes", async () => {
    const logPath = join(
      project.root,
      ".agenttown",
      "runs",
      "run-1",
      "validation",
      "validation-1.log"
    );
    await mkdir(join(logPath, ".."), { recursive: true });
    const log = Buffer.from("passed\n");
    await writeFile(logPath, log);
    const input = validatedInput({
      validations: [{
        record: {
          validationId: "validation-1",
          runId: "run-1",
          taskId: "task-1",
          integrationAttemptId: null,
          command: {
            id: "unit",
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: ".",
            timeoutSeconds: 5
          },
          workspaceId: "workspace-1",
          outcome: "passed",
          exitCode: 0,
          startedAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:00:01.000Z",
          logPath,
          logHash: createHash("sha256").update(log).digest("hex")
        },
        log
      }]
    });
    store.putValidationRun(input.validations[0]!.record);

    const record = await builder.create(input);
    const directory = join(record.manifestPath, "..", "validation");

    expect(await readFile(join(directory, "unit.log"))).toEqual(log);
    expect(JSON.parse(await readFile(join(directory, "unit.json"), "utf8")))
      .toEqual(input.validations[0]?.record);
  });

  it("does not misreport a durable commit when an event listener throws", async () => {
    store.subscribeEvents(() => {
      throw new Error("listener failure");
    });

    await expect(builder.create(validatedInput())).resolves.toMatchObject({
      status: "created"
    });
    expect(store.getReviewPackage("run-1", "task-1", 1)).not.toBeNull();
  });

  it("rejects forged validated input that does not match an active registered workspace", async () => {
    await expect(builder.create(validatedInput({ workspaceId: "workspace-2" })))
      .rejects.toThrow(/workspace|registered/u);
    expect(store.getReviewPackage("run-1", "task-1", 1)).toBeNull();
  });

  it("preserves a uniquely owned temp package after a database failure and converges on retry", async () => {
    store.close();
    const faultStore = new FaultStore(project.databasePath);
    store = faultStore;
    store.initialize();
    builder = new EvidencePackageBuilder({ store, companyId: "company-1" });

    await expect(builder.create(validatedInput()))
      .rejects.toThrow("injected review commit failure");
    const taskDirectory = join(
      project.root,
      ".agenttown",
      "runs",
      "run-1",
      "reviews",
      "task-1"
    );
    expect((await readdir(taskDirectory)).some((name) => name.endsWith(".tmp"))).toBe(true);
    expect(await fileExists(join(taskDirectory, "1"))).toBe(false);

    faultStore.failReviewCommit = false;
    const record = await builder.create(validatedInput());
    expect(await fileExists(record.manifestPath)).toBe(true);
    expect(store.getReviewPackage("run-1", "task-1", 1)).toEqual(record);
  });

  it("rejects a validation directory replaced by a junction", async () => {
    const record = await builder.create(validatedInput());
    const packageDirectory = join(record.manifestPath, "..");
    const validationDirectory = join(packageDirectory, "validation");
    const displaced = join(packageDirectory, "validation-original");
    await rename(validationDirectory, displaced);
    await symlink(displaced, validationDirectory, "junction");

    await expect(builder.verify(record)).rejects.toThrow("tampered");
  });

  it("rejects validation evidence read through a redirected parent directory", async () => {
    const validationDirectory = join(
      project.root,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    const outsideDirectory = join(project.root, "..", `outside-${randomUUID()}`);
    cleanups.push(async () => {
      await rm(outsideDirectory, { recursive: true, force: true });
    });
    await mkdir(outsideDirectory);
    const log = Buffer.from("outside validation\n");
    await writeFile(join(outsideDirectory, "validation-1.log"), log);
    await mkdir(join(validationDirectory, ".."), { recursive: true });
    await symlink(outsideDirectory, validationDirectory, "junction");
    const input = validatedInput({
      validations: [{
        record: {
          validationId: "validation-1",
          runId: "run-1",
          taskId: "task-1",
          integrationAttemptId: null,
          command: {
            id: "unit",
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            cwd: ".",
            timeoutSeconds: 5
          },
          workspaceId: "workspace-1",
          outcome: "passed",
          exitCode: 0,
          startedAt: "2026-07-30T00:00:00.000Z",
          completedAt: "2026-07-30T00:00:01.000Z",
          logPath: join(validationDirectory, "validation-1.log"),
          logHash: createHash("sha256").update(log).digest("hex")
        },
        log
      }]
    });
    store.putValidationRun(input.validations[0]!.record);

    await expect(builder.create(input))
      .rejects.toThrow(/symbolic|reparse|redirect|tamper/u);
  });

  it("refuses to verify a package record absent from the authoritative store", async () => {
    const record = await builder.create(validatedInput());
    const isolated = new CoreStore(join(project.root, "isolated.sqlite"));
    isolated.initialize();
    isolated.createCompany({
      id: "company-1",
      definition: companyDefinitionFixture(),
      event: {
        id: randomUUID(),
        type: "company.created",
        actorId: "owner",
        taskId: null,
        causationEventId: null,
        payload: { companyId: "company-1" }
      }
    });
    isolated.putGitRun(store.getGitRun("run-1")!);
    isolated.putGitWorkspace(store.getGitWorkspace("workspace-1")!);
    const isolatedBuilder = new EvidencePackageBuilder({
      store: isolated,
      companyId: "company-1"
    });

    await expect(isolatedBuilder.verify(record))
      .rejects.toThrow(/authoritative|durable|record/u);
    isolated.close();
  });
});
