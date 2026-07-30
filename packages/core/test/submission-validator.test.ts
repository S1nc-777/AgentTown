import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompanyDefinition,
  GitTaskSubmission,
  GitWorkspaceRecord,
  ValidationCommand
} from "@agenttown/runtime-contract";
import {
  CoreStore,
  SubmissionValidator
} from "../src/index.js";
import { companyDefinitionFixture } from "./helpers.js";
import {
  createGitFixture,
  type GitFixture
} from "./helpers/git-fixture.js";

const fixtures: GitFixture[] = [];
const stores: CoreStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

function submission(headCommit: string, commits: string[]): GitTaskSubmission {
  return {
    schemaVersion: 1,
    headCommit,
    commits,
    changeSummary: "Implement the requested change",
    validationCommandIds: [],
    suggestedValidationCommands: [],
    reportedResults: [],
    knownRisks: []
  };
}

async function setup(options: {
  company?: CompanyDefinition;
  baseBinary?: Buffer;
  firstContent?: string;
  secondContent?: string;
} = {}): Promise<{
  repo: GitFixture;
  store: CoreStore;
  validator: SubmissionValidator;
  workspace: GitWorkspaceRecord;
  base: string;
  first: string;
  second: string;
}> {
  const repo = await createGitFixture();
  fixtures.push(repo);
  if (options.baseBinary !== undefined) {
    await writeFile(join(repo.root, "base.bin"), options.baseBinary);
    await repo.git(["add", "base.bin"]);
    await repo.git(["commit", "-m", "binary base"]);
  }
  const base = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  await repo.git(["checkout", "-b", "agenttown/run-1/developer/task-1"]);
  await repo.write("first.txt", options.firstContent ?? "first\n");
  await repo.git(["add", "first.txt"]);
  await repo.git(["commit", "-m", "first"]);
  const first = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();
  await repo.write("second.txt", options.secondContent ?? "second\n");
  await repo.git(["add", "second.txt"]);
  await repo.git(["commit", "-m", "second"]);
  const second = (await repo.git(["rev-parse", "HEAD"])).stdout.trim();

  const store = new CoreStore(":memory:");
  stores.push(store);
  store.initialize();
  const company = options.company ?? companyDefinitionFixture();
  store.createCompany({
    id: "company-1",
    definition: company,
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
    projectRoot: repo.root,
    originalBranch: "main",
    baseCommit: base,
    integrationRef: "refs/heads/agenttown/run-1/integration",
    integrationCommit: base,
    status: "active",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z"
  });
  const workspace: GitWorkspaceRecord = {
    workspaceId: "workspace-1",
    runId: "run-1",
    taskId: "task-1",
    employeeId: "developer",
    kind: "task",
    path: repo.root,
    branchRef: "refs/heads/agenttown/run-1/developer/task-1",
    baseCommit: base,
    headCommit: second,
    status: "active"
  };
  store.putGitWorkspace(workspace);
  return {
    repo,
    store,
    validator: new SubmissionValidator({ store, companyId: "company-1" }),
    workspace,
    base,
    first,
    second
  };
}

describe("SubmissionValidator", () => {
  it("accepts the exact continuous commits after the task base", async () => {
    const fixture = await setup();

    const result = await fixture.validator.validate(
      fixture.workspace,
      submission(fixture.second, [fixture.first, fixture.second])
    );

    expect(result.commits.map(({ id }) => id))
      .toEqual([fixture.first, fixture.second]);
    expect(result.baseCommit).toBe(fixture.base);
    expect(result.headCommit).toBe(fixture.second);
    expect(result.files.map(({ path }) => path))
      .toEqual(["first.txt", "second.txt"]);
    expect(result.patch).toContain("first.txt");
  });

  it("rejects an unsupported submission schema version at runtime", async () => {
    const fixture = await setup();
    const declared = {
      ...submission(fixture.second, [fixture.first, fixture.second]),
      schemaVersion: 2 as 1
    };

    await expect(fixture.validator.validate(fixture.workspace, declared))
      .rejects.toThrow(/schema|version/u);
  });

  it.each([
    ["omitted commit", (first: string, second: string) => [second]],
    ["reordered commit", (first: string, second: string) => [second, first]],
    ["duplicate commit", (first: string, second: string) => [first, first, second]],
    ["foreign commit", (_first: string, second: string) => ["f".repeat(40), second]]
  ])("rejects %s", async (_label, declared) => {
    const fixture = await setup();

    await expect(fixture.validator.validate(
      fixture.workspace,
      submission(fixture.second, declared(fixture.first, fixture.second))
    )).rejects.toThrow(/commit/u);
  });

  it.each(["index", "worktree", "untracked"] as const)(
    "rejects a dirty %s",
    async (kind) => {
      const fixture = await setup();
      if (kind === "index") {
        await fixture.repo.write("staged.txt", "staged\n");
        await fixture.repo.git(["add", "staged.txt"]);
      } else if (kind === "worktree") {
        await fixture.repo.write("second.txt", "dirty\n");
      } else {
        await fixture.repo.write("untracked.txt", "untracked\n");
      }

      await expect(fixture.validator.validate(
        fixture.workspace,
        submission(fixture.second, [fixture.first, fixture.second])
      )).rejects.toThrow(/clean|dirty/u);
    }
  );

  it("records binary metadata without embedding bytes in the patch", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.repo.root, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await fixture.repo.git(["add", "binary.bin"]);
    await fixture.repo.git(["commit", "-m", "binary"]);
    const binaryHead = (await fixture.repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const registered = { ...fixture.workspace, headCommit: binaryHead };
    fixture.store.putGitWorkspace(registered);

    const result = await fixture.validator.validate(
      registered,
      submission(binaryHead, [fixture.first, fixture.second, binaryHead])
    );
    const binary = result.files.find(({ path }) => path === "binary.bin");

    expect(binary).toMatchObject({
      binary: true,
      size: 4,
      sha256: createHash("sha256").update(Buffer.from([0, 1, 2, 255])).digest("hex")
    });
    expect(result.patch).not.toContain("base64");
    expect(result.patch).not.toContain("GIT binary patch");
  });

  it("hashes a deleted binary from Git blob bytes", async () => {
    const bytes = Buffer.from([0, 3, 255, 7]);
    const fixture = await setup({ baseBinary: bytes });
    await rm(join(fixture.repo.root, "base.bin"));
    await fixture.repo.git(["add", "base.bin"]);
    await fixture.repo.git(["commit", "-m", "delete binary"]);
    const head = (await fixture.repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const registered = { ...fixture.workspace, headCommit: head };
    fixture.store.putGitWorkspace(registered);

    const result = await fixture.validator.validate(
      registered,
      submission(head, [fixture.first, fixture.second, head])
    );
    const deleted = result.files.find(({ path }) => path === "base.bin");

    expect(deleted).toMatchObject({
      status: "deleted",
      binary: true,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  });

  it("hashes a renamed binary without reading an unrelated filesystem target", async () => {
    const bytes = Buffer.from([0, 9, 128, 255]);
    const fixture = await setup({ baseBinary: bytes });
    await fixture.repo.git(["mv", "base.bin", "renamed.bin"]);
    await fixture.repo.git(["commit", "-m", "rename binary"]);
    const head = (await fixture.repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const registered = { ...fixture.workspace, headCommit: head };
    fixture.store.putGitWorkspace(registered);

    const result = await fixture.validator.validate(
      registered,
      submission(head, [fixture.first, fixture.second, head])
    );
    const renamed = result.files.find(({ path }) => path === "renamed.bin");

    expect(renamed).toMatchObject({
      status: "renamed",
      oldPath: "base.bin",
      binary: true,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  });

  it("models a symlink as Git link-target bytes and never follows it outside", async () => {
    const fixture = await setup();
    const outside = join(fixture.repo.root, "..", "outside-secret.txt");
    await writeFile(outside, "outside secret");
    await fixture.repo.write("outside-link", outside);
    const linkBlob = (await fixture.repo.git([
      "hash-object",
      "-w",
      "outside-link"
    ])).stdout.trim();
    await fixture.repo.git([
      "update-index",
      "--add",
      "--cacheinfo",
      "120000",
      linkBlob,
      "outside-link"
    ]);
    await fixture.repo.git(["commit", "-m", "link"]);
    const head = (await fixture.repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const registered = { ...fixture.workspace, headCommit: head };
    fixture.store.putGitWorkspace(registered);

    const result = await fixture.validator.validate(
      registered,
      submission(head, [fixture.first, fixture.second, head])
    );
    const link = result.files.find(({ path }) => path === "outside-link");
    const linkBytes = Buffer.from(outside);

    expect(link).toMatchObject({
      status: "added",
      newMode: "120000",
      binary: false,
      size: linkBytes.length,
      sha256: createHash("sha256").update(linkBytes).digest("hex")
    });
    expect(result.patch).not.toContain("outside secret");
  });

  it("uses persisted company evidence limits and records a warning", async () => {
    const company = companyDefinitionFixture();
    company.evidence = {
      diffWarningBytes: 256 * 1024,
      diffHardLimitBytes: 1024 * 1024
    };
    const fixture = await setup({
      company,
      firstContent: `${"x".repeat(300 * 1024)}\n`
    });

    const result = await fixture.validator.validate(
      fixture.workspace,
      submission(fixture.second, [fixture.first, fixture.second])
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "patch_warning_limit_exceeded" })
    ]);
  });

  it("requires authoritative passed validation evidence with matching log bytes", async () => {
    const command: ValidationCommand = {
      id: "unit",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutSeconds: 5
    };
    const company = companyDefinitionFixture();
    company.validation = { commands: [command], integrationCommandIds: [] };
    const fixture = await setup({ company });
    const validationDirectory = join(
      fixture.repo.root,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    await appendFile(await fixture.repo.gitPath("info/exclude"), "/.agenttown/\n");
    await mkdir(validationDirectory, { recursive: true });
    const logPath = join(validationDirectory, "validation-1.log");
    const log = Buffer.from("passed\n");
    await writeFile(logPath, log);
    fixture.store.putValidationRun({
      validationId: "validation-1",
      runId: "run-1",
      taskId: "task-1",
      integrationAttemptId: null,
      command,
      workspaceId: "workspace-1",
      outcome: "passed",
      exitCode: 0,
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:01.000Z",
      logPath,
      logHash: createHash("sha256").update(log).digest("hex")
    });
    const declared = {
      ...submission(fixture.second, [fixture.first, fixture.second]),
      validationCommandIds: ["unit"],
      reportedResults: [{
        commandId: "unit" as const,
        outcome: "failed" as const,
        summary: "caller claim is not authoritative"
      }]
    };

    const result = await fixture.validator.validate(fixture.workspace, declared);

    expect(result.validations).toHaveLength(1);
    expect(result.validations[0]?.record.outcome).toBe("passed");
    await writeFile(logPath, "tampered\n");
    await expect(fixture.validator.validate(fixture.workspace, declared))
      .rejects.toThrow(/hash|tamper/u);
  });

  it("rejects a validation directory redirected outside the project", async () => {
    const command: ValidationCommand = {
      id: "unit",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      timeoutSeconds: 5
    };
    const company = companyDefinitionFixture();
    company.validation = { commands: [command], integrationCommandIds: [] };
    const fixture = await setup({ company });
    await appendFile(await fixture.repo.gitPath("info/exclude"), "/.agenttown/\n");
    const validationDirectory = join(
      fixture.repo.root,
      ".agenttown",
      "runs",
      "run-1",
      "validation"
    );
    const outsideDirectory = join(fixture.repo.root, "..", "redirected-validation");
    await mkdir(outsideDirectory, { recursive: true });
    const logPath = join(outsideDirectory, "validation-1.log");
    const log = Buffer.from("passed outside\n");
    await writeFile(logPath, log);
    await mkdir(join(validationDirectory, ".."), { recursive: true });
    await symlink(outsideDirectory, validationDirectory, "junction");
    fixture.store.putValidationRun({
      validationId: "validation-1",
      runId: "run-1",
      taskId: "task-1",
      integrationAttemptId: null,
      command,
      workspaceId: "workspace-1",
      outcome: "passed",
      exitCode: 0,
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:01.000Z",
      logPath: join(validationDirectory, "validation-1.log"),
      logHash: createHash("sha256").update(log).digest("hex")
    });
    const declared = {
      ...submission(fixture.second, [fixture.first, fixture.second]),
      validationCommandIds: ["unit"]
    };

    await expect(fixture.validator.validate(fixture.workspace, declared))
      .rejects.toThrow(/symbolic|reparse|redirect|tamper/u);
  });

  it("rejects a gitlink in the submitted range", async () => {
    const fixture = await setup();
    const nested = join(fixture.repo.root, "nested");
    await mkdir(nested);
    await fixture.repo.git(["-C", nested, "init", "-b", "main"]);
    await fixture.repo.git(["-C", nested, "config", "user.name", "Nested Test"]);
    await fixture.repo.git(["-C", nested, "config", "user.email", "nested@example.invalid"]);
    await writeFile(join(nested, "README.md"), "nested\n");
    await fixture.repo.git(["-C", nested, "add", "README.md"]);
    await fixture.repo.git(["-C", nested, "commit", "-m", "nested"]);
    const nestedHead = (await fixture.repo.git(["-C", nested, "rev-parse", "HEAD"])).stdout.trim();
    await fixture.repo.git([
      "update-index",
      "--add",
      "--cacheinfo",
      "160000",
      nestedHead,
      "nested"
    ]);
    await fixture.repo.git(["commit", "-m", "gitlink"]);
    const head = (await fixture.repo.git(["rev-parse", "HEAD"])).stdout.trim();
    const registered = { ...fixture.workspace, headCommit: head };
    fixture.store.putGitWorkspace(registered);

    await expect(fixture.validator.validate(
      registered,
      submission(head, [fixture.first, fixture.second, head])
    )).rejects.toThrow(/gitlink|submodule/u);
  });
});
