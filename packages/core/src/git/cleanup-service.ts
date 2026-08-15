import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CleanupExecuteResult,
  CleanupPreview,
  CleanupSelection,
  ReviewPackageRecord
} from "@agenttown/runtime-contract";
import { CoreStore } from "../storage/core-store.js";
import {
  GitCommandRunner,
  type GitCommandOptions,
  type GitCommandResult
} from "./git-command.js";
import type { WorkspaceManager } from "./workspace-manager.js";

interface CleanupGitRunner {
  run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult>;
}

interface CleanupWorkspaceManager {
  removeVerifiedWorkspace(workspaceId: string): Promise<void>;
}

export interface CleanupServiceOptions {
  store: CoreStore;
  companyId: string;
  workspaceManager: Pick<WorkspaceManager, "removeVerifiedWorkspace">;
  git?: CleanupGitRunner;
  actorId?: string;
}

interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === ""
    || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function exactRunId(value: string): string {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value) || value === "all") {
    throw new TypeError("cleanup requires one exact lowercase run id");
  }
  return value;
}

function parseWorktrees(output: string): WorktreeEntry[] {
  return output.trim().length === 0
    ? []
    : output.trim().split(/\r?\n\r?\n/u).map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split(/\r?\n/u)) {
        const separator = line.indexOf(" ");
        fields.set(
          separator < 0 ? line : line.slice(0, separator),
          separator < 0 ? "" : line.slice(separator + 1)
        );
      }
      return {
        path: fields.get("worktree") ?? "",
        head: fields.get("HEAD") ?? "",
        branch: fields.get("branch") ?? null
      };
    });
}

async function optionalStat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class CleanupService {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #workspaceManager: CleanupWorkspaceManager;
  readonly #git: CleanupGitRunner;
  readonly #actorId: string;

  constructor(options: CleanupServiceOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
    this.#workspaceManager = options.workspaceManager;
    this.#git = options.git ?? new GitCommandRunner();
    this.#actorId = options.actorId ?? "core";
  }

  async preview(selection: CleanupSelection): Promise<CleanupPreview> {
    const runId = exactRunId(selection.runId);
    const run = this.#store.getGitRun(runId);
    if (run === null || run.companyId !== this.#companyId) {
      throw new Error(`Git run not found for company: ${runId}`);
    }
    if (run.status !== "paused" && run.status !== "completed") {
      throw new Error("cleanup requires a paused or completed Git run");
    }
    if (selection.removeWorktrees !== true) {
      if (!selection.removeEvidence) {
        throw new Error("cleanup must select worktrees or evidence");
      }
    }

    const worktreeOutput = await this.#git.run(
      ["worktree", "list", "--porcelain"],
      { cwd: run.projectRoot }
    );
    const registered = parseWorktrees(worktreeOutput.stdout);
    const workspaces = [] as CleanupPreview["workspaces"];
    const branches = [] as CleanupPreview["branchRefs"];
    const identity: unknown[] = [];

    for (const workspace of this.#store.listGitWorkspaces(runId)) {
      if (workspace.status === "tampered" || workspace.status === "active") {
        throw new Error(`workspace is not eligible for cleanup: ${workspace.workspaceId}: ${workspace.status}`);
      }
      const branch = await this.#readRef(run.projectRoot, workspace.branchRef);
      if (branch !== null && branch !== workspace.headCommit) {
        throw new Error(`workspace branch ref mismatch: ${workspace.workspaceId}`);
      }
      const matches = registered.filter((entry) =>
        pathKey(entry.path) === pathKey(workspace.path));
      const metadata = await optionalStat(workspace.path);
      if (workspace.status === "missing") {
        if (matches.length !== 0 || metadata !== null) {
          throw new Error(`missing workspace reappeared: ${workspace.workspaceId}`);
        }
      } else {
        if (matches.length !== 1 || metadata === null || !metadata.isDirectory()
          || metadata.isSymbolicLink()) {
          throw new Error(`workspace path or registration mismatch: ${workspace.workspaceId}`);
        }
        const entry = matches[0]!;
        if (entry.branch !== workspace.branchRef || entry.head !== workspace.headCommit) {
          throw new Error(`workspace Git identity mismatch: ${workspace.workspaceId}`);
        }
        const expectedRoot = resolve(run.projectRoot, ".agenttown", "worktrees", runId);
        const actual = await realpath(workspace.path);
        if (!isWithin(await realpath(expectedRoot), actual)) {
          throw new Error(`workspace path escaped run root: ${workspace.workspaceId}`);
        }
        const status = await this.#git.run(
          ["status", "--porcelain=v2", "--untracked-files=all"],
          { cwd: workspace.path }
        );
        if (status.stdout.length !== 0) {
          throw new Error(`Git workspace has uncommitted changes: ${workspace.workspaceId}`);
        }
        const head = (await this.#git.run(["rev-parse", "HEAD"], {
          cwd: workspace.path
        })).stdout.trim();
        const symbolic = (await this.#git.run(["symbolic-ref", "--quiet", "HEAD"], {
          cwd: workspace.path
        })).stdout.trim();
        if (head !== workspace.headCommit || symbolic !== workspace.branchRef) {
          throw new Error(`workspace head changed: ${workspace.workspaceId}`);
        }
        if (selection.removeWorktrees) {
          workspaces.push({
            workspaceId: workspace.workspaceId,
            path: workspace.path,
            branchRef: workspace.branchRef,
            headCommit: workspace.headCommit
          });
          identity.push({
            workspaceId: workspace.workspaceId,
            device: metadata.dev,
            inode: metadata.ino,
            modifiedMs: metadata.mtimeMs
          });
        }
      }
      if (selection.removeBranches && branch !== null) {
        branches.push({ ref: workspace.branchRef, headCommit: workspace.headCommit });
      }
    }

    const packages = selection.removeEvidence
      ? this.#store.listReviewPackages(runId).filter(({ status }) => status !== "deleted")
      : [];
    const evidenceRoots: string[] = [];
    const evidenceIdentity: unknown[] = [];
    const allowedEvidenceRoot = resolve(run.projectRoot, ".agenttown", "runs", runId);
    for (const record of packages) {
      const evidenceRoot = resolve(dirname(record.manifestPath));
      if (!isWithin(allowedEvidenceRoot, evidenceRoot)) {
        throw new Error(`review package escaped exact run evidence root: ${record.taskId}`);
      }
      const rootMetadata = await optionalStat(evidenceRoot);
      const manifestMetadata = await optionalStat(record.manifestPath);
      if (rootMetadata === null || manifestMetadata === null
        || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
        || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
        throw new Error(`review package is missing or redirected: ${record.taskId}`);
      }
      if (!isWithin(await realpath(allowedEvidenceRoot), await realpath(evidenceRoot))) {
        throw new Error(`review package resolved outside exact run evidence root: ${record.taskId}`);
      }
      const actualHash = createHash("sha256")
        .update(await readFile(record.manifestPath))
        .digest("hex");
      if (actualHash !== record.manifestHash) {
        throw new Error(`review package manifest hash mismatch: ${record.taskId}`);
      }
      evidenceRoots.push(evidenceRoot);
      evidenceIdentity.push({
        path: evidenceRoot,
        device: rootMetadata.dev,
        inode: rootMetadata.ino,
        modifiedMs: rootMetadata.mtimeMs,
        manifestHash: actualHash
      });
    }
    const validations = selection.removeEvidence
      ? this.#store.listValidationRuns(runId)
      : [];
    const allowedValidationRoot = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      runId,
      "validation"
    );
    for (const validation of validations) {
      const logPath = resolve(validation.logPath);
      if (!isWithin(allowedValidationRoot, logPath)) {
        throw new Error(`validation log escaped exact run evidence root: ${validation.validationId}`);
      }
      const metadata = await optionalStat(logPath);
      if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`validation log is missing or redirected: ${validation.validationId}`);
      }
      if (!isWithin(await realpath(allowedValidationRoot), await realpath(logPath))) {
        throw new Error(`validation log resolved outside exact run evidence root: ${validation.validationId}`);
      }
      const actualHash = createHash("sha256")
        .update(await readFile(logPath))
        .digest("hex");
      if (actualHash !== validation.logHash) {
        throw new Error(`validation log hash mismatch: ${validation.validationId}`);
      }
      evidenceRoots.push(logPath);
      evidenceIdentity.push({
        path: logPath,
        device: metadata.dev,
        inode: metadata.ino,
        modifiedMs: metadata.mtimeMs,
        logHash: actualHash
      });
    }

    workspaces.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId, "en"));
    branches.sort((left, right) => left.ref.localeCompare(right.ref, "en"));
    evidenceRoots.sort((left, right) => left.localeCompare(right, "en"));
    const exactSelection = {
      runId,
      removeWorktrees: selection.removeWorktrees,
      removeBranches: selection.removeBranches,
      removeEvidence: selection.removeEvidence
    };
    const fingerprint = createHash("sha256").update(stableJson({
      selection: exactSelection,
      run,
      workspaces,
      branches,
      evidenceRoots,
      identity,
      evidenceIdentity
    })).digest("hex");
    return {
      ...exactSelection,
      workspaces,
      branchRefs: branches,
      evidenceRoots,
      fingerprint
    };
  }

  async execute(
    input: CleanupSelection & { fingerprint: string }
  ): Promise<CleanupExecuteResult> {
    if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) {
      throw new TypeError("cleanup fingerprint must be a SHA-256 hash");
    }
    const preview = await this.preview(input);
    if (preview.fingerprint !== input.fingerprint) {
      throw new Error("cleanup state changed after preview; request a new fingerprint");
    }
    const run = this.#store.getGitRun(preview.runId)!;
    for (const workspace of preview.workspaces) {
      await this.#workspaceManager.removeVerifiedWorkspace(workspace.workspaceId);
    }
    for (const branch of preview.branchRefs) {
      const current = await this.#readRef(run.projectRoot, branch.ref);
      if (current !== branch.headCommit) {
        throw new Error(`cleanup branch changed after preview: ${branch.ref}`);
      }
      const removed = await this.#git.run(
        ["update-ref", "-d", branch.ref, branch.headCommit],
        { cwd: run.projectRoot, allowedExitCodes: [0, 1, 128] }
      );
      if (removed.exitCode !== 0
        || await this.#readRef(run.projectRoot, branch.ref) !== null) {
        throw new Error(`verified branch cleanup failed: ${branch.ref}`);
      }
    }
    for (const evidenceRoot of preview.evidenceRoots) {
      await rm(evidenceRoot, { recursive: true, force: false });
    }
    const deletedPackages = this.#store.listReviewPackages(preview.runId)
      .filter((record) => record.status !== "deleted"
        && preview.evidenceRoots.some((root) => pathKey(root) === pathKey(dirname(record.manifestPath))))
      .map((record): ReviewPackageRecord => ({ ...record, status: "deleted" }));
    const deletedValidationRunIds = this.#store.listValidationRuns(preview.runId)
      .filter((record) => preview.evidenceRoots.some(
        (root) => pathKey(root) === pathKey(record.logPath)
      ))
      .map(({ validationId }) => validationId);
    this.#store.commitGitCleanup({
      runId: preview.runId,
      reviewPackages: deletedPackages,
      validationRunIds: deletedValidationRunIds,
      event: {
        id: randomUUID(),
        type: "git.cleanup.completed",
        actorId: this.#actorId,
        taskId: null,
        causationEventId: null,
        payload: {
          runId: preview.runId,
          removedWorkspaceIds: preview.workspaces.map(({ workspaceId }) => workspaceId),
          removedBranchRefs: preview.branchRefs.map(({ ref }) => ref),
          removedEvidenceRoots: preview.evidenceRoots
        }
      }
    });
    return {
      removedWorkspaces: preview.workspaces.length,
      removedBranches: preview.branchRefs.length,
      removedEvidenceRoots: preview.evidenceRoots.length
    };
  }

  async #readRef(projectRoot: string, ref: string): Promise<string | null> {
    const result = await this.#git.run(
      ["show-ref", "--verify", "--hash", ref],
      { cwd: projectRoot, allowedExitCodes: [0, 1, 128] }
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }
}
