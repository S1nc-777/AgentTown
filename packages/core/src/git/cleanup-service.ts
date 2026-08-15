import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CleanupExecuteResult,
  CleanupPreview,
  CleanupSelection,
  ReviewPackageRecord,
  ValidationRunRecord
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

export interface CleanupServiceDependencies {
  afterEvidencePrepared?: () => Promise<void>;
  afterDatabaseCommitted?: () => Promise<void>;
  commitCleanup?: (
    input: Parameters<CoreStore["commitGitCleanup"]>[0]
  ) => void;
  removeQuarantinedDirectory?: typeof rm;
}

const injectedDependencies = new WeakMap<CleanupService, CleanupServiceDependencies>();

export function createInjectedCleanupService(
  options: CleanupServiceOptions,
  dependencies: CleanupServiceDependencies
): CleanupService {
  const service = new CleanupService(options);
  injectedDependencies.set(service, dependencies);
  return service;
}

interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
}

interface VerifiedFile {
  path: string;
  size: number;
  sha256: string;
}

interface VerifiedEvidence {
  reviewPackages: ReviewPackageRecord[];
  validationRuns: ValidationRunRecord[];
  roots: string[];
  files: VerifiedFile[];
  inventories: Array<{
    path: string;
    kind: "file" | "directory";
    files: VerifiedFile[];
    directories: string[];
  }>;
}

interface CleanupEvidenceMove {
  source: string;
  quarantine: string;
  kind: "file" | "directory";
  files: VerifiedFile[];
  directories: string[];
}

interface CleanupIntent {
  schemaVersion: 1;
  intentId: string;
  runId: string;
  fingerprint: string;
  workspaces: CleanupPreview["workspaces"];
  branchRefs: CleanupPreview["branchRefs"];
  reviewPackages: ReviewPackageRecord[];
  validationRuns: ValidationRunRecord[];
  evidenceMoves: CleanupEvidenceMove[];
}

interface ManifestFile {
  size: number;
  sha256: string;
}

interface EvidenceManifest {
  schemaVersion: number;
  runId: string;
  taskId: string;
  revision: number;
  files: Record<string, ManifestFile>;
  totalFiles: number;
  totalBytes: number;
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

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeManifestPath(path: string): boolean {
  if (path.length === 0 || path.includes("\\") || path.startsWith("/")
    || path.includes("\0")) return false;
  return path.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function assertSafeTree(root: string, target: string): Promise<string> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error("evidence path escaped its durable project root");
  }
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("evidence project root is redirected");
  }
  const rootReal = await realpath(resolvedRoot);
  if (pathKey(rootReal) !== pathKey(resolvedRoot)) {
    throw new Error("evidence project root is a reparse redirect");
  }
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedTarget).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("evidence path contains a redirect or non-directory");
    }
    const currentReal = await realpath(current);
    if (!isWithin(rootReal, currentReal)
      || pathKey(currentReal) !== pathKey(current)) {
      throw new Error("evidence path contains a reparse redirect");
    }
  }
  return rootReal;
}

async function verifiedFile(
  projectRoot: string,
  allowedRoot: string,
  filePath: string
): Promise<{ fact: VerifiedFile; bytes: Buffer }> {
  await assertSafeTree(projectRoot, dirname(filePath));
  const allowedReal = await realpath(allowedRoot);
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`evidence file is redirected or not ordinary: ${filePath}`);
  }
  const fileReal = await realpath(filePath);
  if (!isWithin(allowedReal, fileReal) || pathKey(fileReal) !== pathKey(filePath)) {
    throw new Error(`evidence file escaped its durable root: ${filePath}`);
  }
  const bytes = await readFile(filePath);
  const after = await lstat(filePath);
  if (after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || !after.isFile() || after.isSymbolicLink()) {
    throw new Error(`evidence file identity changed while reading: ${filePath}`);
  }
  return {
    fact: {
      path: resolve(filePath),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    },
    bytes
  };
}

async function exactTreeInventory(
  projectRoot: string,
  packageRoot: string
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    await assertSafeTree(projectRoot, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`evidence inventory contains a redirect: ${absolute}`);
      }
      const relativePath = relative(packageRoot, absolute).replaceAll("\\", "/");
      if (entry.isDirectory() && metadata.isDirectory()) {
        directories.push(relativePath);
        await visit(absolute);
      } else if (entry.isFile() && metadata.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`evidence inventory contains a non-ordinary object: ${absolute}`);
      }
    }
  };
  await visit(packageRoot);
  return { files: files.sort(), directories: directories.sort() };
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
    await this.#recoverCleanupIntents(run);
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
    const storedWorkspaces = this.#store.listGitWorkspaces(runId);
    const workspaces = [] as CleanupPreview["workspaces"];
    const branches = [] as CleanupPreview["branchRefs"];
    const identity: unknown[] = [];

    const runWorktreesRoot = resolve(run.projectRoot, ".agenttown", "worktrees", runId);
    const registeredPaths = new Set(storedWorkspaces.map(({ path }) => pathKey(path)));
    for (const entry of registered) {
      if (entry.path.length !== 0
        && isWithin(runWorktreesRoot, resolve(entry.path))
        && !registeredPaths.has(pathKey(entry.path))) {
        throw new Error(`cleanup found foreign worktree in run namespace: ${entry.path}`);
      }
    }
    const registeredRefs = new Set(storedWorkspaces.map(({ branchRef }) => branchRef));
    const refsOutput = await this.#git.run(
      ["for-each-ref", "--format=%(refname)", `refs/heads/agenttown/${runId}/`],
      { cwd: run.projectRoot }
    );
    for (const ref of refsOutput.stdout.trim().split(/\r?\n/u)) {
      if (ref.length !== 0 && !registeredRefs.has(ref)) {
        throw new Error(`cleanup found foreign branch ref: ${ref}`);
      }
    }

    for (const workspace of storedWorkspaces) {
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

    const evidence = selection.removeEvidence
      ? await this.#verifyEvidence(run)
      : { reviewPackages: [], validationRuns: [], roots: [], files: [], inventories: [] };
    const evidenceRoots = evidence.roots;

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
      reviewPackages: evidence.reviewPackages,
      validationRuns: evidence.validationRuns,
      evidenceFiles: evidence.files
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
    const evidence = preview.removeEvidence
      ? await this.#verifyEvidence(run)
      : { reviewPackages: [], validationRuns: [], roots: [], files: [], inventories: [] };
    const intent = this.#cleanupIntent(run, preview, evidence);
    this.#store.insertEvent({
      id: randomUUID(),
      type: "git.cleanup.prepared",
      actorId: this.#actorId,
      taskId: null,
      causationEventId: null,
      payload: { runId: run.runId, intentId: intent.intentId, intent }
    });
    await this.#prepareEvidence(run, intent);
    await injectedDependencies.get(this)?.afterEvidencePrepared?.();
    const commitCleanup = injectedDependencies.get(this)?.commitCleanup
      ?? ((value: Parameters<CoreStore["commitGitCleanup"]>[0]) =>
        this.#store.commitGitCleanup(value));
    commitCleanup({
      runId: preview.runId,
      reviewPackages: intent.reviewPackages.map(
        (record): ReviewPackageRecord => ({ ...record, status: "deleted" })
      ),
      validationRunIds: intent.validationRuns.map(({ validationId }) => validationId),
      event: {
        id: randomUUID(),
        type: "git.cleanup.committed",
        actorId: this.#actorId,
        taskId: null,
        causationEventId: null,
        payload: {
          runId: preview.runId,
          intentId: intent.intentId,
          removedWorkspaceIds: preview.workspaces.map(({ workspaceId }) => workspaceId),
          removedBranchRefs: preview.branchRefs.map(({ ref }) => ref),
          removedEvidenceRoots: preview.evidenceRoots
        }
      }
    });
    await injectedDependencies.get(this)?.afterDatabaseCommitted?.();
    await this.#finalizeIntent(run, intent);
    this.#recordIntentTerminal("git.cleanup.completed", intent);
    return {
      removedWorkspaces: preview.workspaces.length,
      removedBranches: preview.branchRefs.length,
      removedEvidenceRoots: preview.evidenceRoots.length
    };
  }

  #cleanupIntent(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    preview: CleanupPreview,
    evidence: VerifiedEvidence
  ): CleanupIntent {
    const intentId = `cleanup-${randomUUID()}`;
    const quarantineRoot = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      run.runId,
      "cleanup",
      intentId,
      "objects"
    );
    return {
      schemaVersion: 1,
      intentId,
      runId: run.runId,
      fingerprint: preview.fingerprint,
      workspaces: preview.workspaces.map((workspace) => ({ ...workspace })),
      branchRefs: preview.branchRefs.map((branch) => ({ ...branch })),
      reviewPackages: evidence.reviewPackages.map((record) => ({ ...record })),
      validationRuns: evidence.validationRuns.map((record) => ({
        ...record,
        command: { ...record.command, args: [...record.command.args] }
      })),
      evidenceMoves: evidence.inventories.map((inventory, index) => ({
        source: inventory.path,
        quarantine: resolve(quarantineRoot, String(index).padStart(6, "0")),
        kind: inventory.kind,
        files: inventory.files.map((file) => ({ ...file })),
        directories: [...inventory.directories]
      }))
    };
  }

  async #prepareEvidence(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    intent: CleanupIntent
  ): Promise<void> {
    if (intent.evidenceMoves.length === 0) return;
    const runRoot = resolve(run.projectRoot, ".agenttown", "runs", run.runId);
    const cleanupRoot = resolve(runRoot, "cleanup");
    const intentRoot = resolve(cleanupRoot, intent.intentId);
    const objectsRoot = resolve(intentRoot, "objects");
    await assertSafeTree(run.projectRoot, runRoot);
    for (const directory of [cleanupRoot, intentRoot, objectsRoot]) {
      try {
        await mkdir(directory);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error)
          || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await assertSafeTree(run.projectRoot, directory);
    }
    for (const move of intent.evidenceMoves) {
      if (!isWithin(objectsRoot, move.quarantine)
        || await optionalStat(move.quarantine) !== null) {
        throw new Error("cleanup quarantine target is not exact and empty");
      }
      await this.#verifyMoveAt(run.projectRoot, move, move.source);
      await rename(move.source, move.quarantine);
    }
  }

  async #recoverCleanupIntents(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>
  ): Promise<void> {
    const events = this.#store.listEvents(0);
    const prepared = new Map<string, CleanupIntent>();
    const committed = new Set<string>();
    const terminal = new Set<string>();
    for (const event of events) {
      const eventRunId = event.payload.runId;
      const intentId = event.payload.intentId;
      if (eventRunId !== run.runId || typeof intentId !== "string") continue;
      if (event.type === "git.cleanup.prepared") {
        prepared.set(intentId, this.#parseIntent(event.payload.intent, run));
      } else if (event.type === "git.cleanup.committed") {
        committed.add(intentId);
      } else if (event.type === "git.cleanup.completed"
        || event.type === "git.cleanup.rolled_back") {
        terminal.add(intentId);
      }
    }
    for (const [intentId, intent] of prepared) {
      if (terminal.has(intentId)) continue;
      if (committed.has(intentId)) {
        await this.#finalizeIntent(run, intent);
        this.#recordIntentTerminal("git.cleanup.completed", intent);
      } else {
        await this.#rollbackIntent(run, intent);
        this.#recordIntentTerminal("git.cleanup.rolled_back", intent);
      }
    }
  }

  #parseIntent(
    value: unknown,
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>
  ): CleanupIntent {
    if (!isRecord(value) || value.schemaVersion !== 1
      || typeof value.intentId !== "string"
      || !/^cleanup-[0-9a-f-]{36}$/u.test(value.intentId)
      || value.runId !== run.runId
      || typeof value.fingerprint !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.fingerprint)
      || !Array.isArray(value.workspaces) || !Array.isArray(value.branchRefs)
      || !Array.isArray(value.reviewPackages) || !Array.isArray(value.validationRuns)
      || !Array.isArray(value.evidenceMoves)) {
      throw new Error("durable cleanup intent is malformed");
    }
    const intent = value as unknown as CleanupIntent;
    const objectsRoot = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      run.runId,
      "cleanup",
      intent.intentId,
      "objects"
    );
    for (const move of intent.evidenceMoves) {
      if (!isRecord(move) || typeof move.source !== "string"
        || typeof move.quarantine !== "string"
        || (move.kind !== "file" && move.kind !== "directory")
        || !Array.isArray(move.files) || !Array.isArray(move.directories)
        || !isWithin(objectsRoot, resolve(move.quarantine))) {
        throw new Error("durable cleanup evidence move is malformed");
      }
    }
    return intent;
  }

  async #rollbackIntent(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    intent: CleanupIntent
  ): Promise<void> {
    for (const move of [...intent.evidenceMoves].reverse()) {
      const source = await optionalStat(move.source);
      const quarantined = await optionalStat(move.quarantine);
      if (source !== null && quarantined === null) {
        await this.#verifyMoveAt(run.projectRoot, move, move.source);
        continue;
      }
      if (source === null && quarantined !== null) {
        await this.#verifyMoveAt(run.projectRoot, move, move.quarantine);
        await assertSafeTree(run.projectRoot, dirname(move.source));
        await rename(move.quarantine, move.source);
        continue;
      }
      throw new Error("cleanup rollback found missing or duplicate evidence objects");
    }
    await this.#removeEmptyQuarantine(run, intent);
  }

  async #finalizeIntent(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    intent: CleanupIntent
  ): Promise<void> {
    for (const workspace of intent.workspaces) {
      await this.#workspaceManager.removeVerifiedWorkspace(workspace.workspaceId);
    }
    for (const branch of intent.branchRefs) {
      const current = await this.#readRef(run.projectRoot, branch.ref);
      if (current === null) continue;
      if (current !== branch.headCommit) {
        throw new Error(`cleanup branch changed during finalize: ${branch.ref}`);
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
    for (const move of intent.evidenceMoves) {
      const source = await optionalStat(move.source);
      const quarantined = await optionalStat(move.quarantine);
      if (quarantined === null) {
        if (source !== null) {
          throw new Error("committed cleanup evidence returned to its source path");
        }
        continue;
      }
      if (source !== null) {
        throw new Error("committed cleanup has duplicate evidence objects");
      }
      await this.#verifyMoveAt(run.projectRoot, move, move.quarantine);
      if (move.kind === "directory") {
        const remove = injectedDependencies.get(this)?.removeQuarantinedDirectory ?? rm;
        await remove(move.quarantine, { recursive: true, force: false });
      } else {
        await rm(move.quarantine, { recursive: false, force: false });
      }
    }
    await this.#removeEmptyQuarantine(run, intent);
  }

  async #verifyMoveAt(
    projectRoot: string,
    move: CleanupEvidenceMove,
    location: string
  ): Promise<void> {
    if (move.kind === "file") {
      if (move.files.length !== 1) throw new Error("cleanup file inventory is not exact");
      const actual = await verifiedFile(projectRoot, dirname(location), location);
      const expected = move.files[0]!;
      if (actual.fact.size !== expected.size || actual.fact.sha256 !== expected.sha256) {
        throw new Error("cleanup evidence file changed after preview");
      }
      return;
    }
    const inventory = await exactTreeInventory(projectRoot, location);
    const expectedFiles = move.files.map((file) =>
      relative(move.source, file.path).replaceAll("\\", "/")).sort();
    const expectedDirectories = [...move.directories].sort();
    if (!sameJson(inventory.files, expectedFiles)
      || !sameJson(inventory.directories, expectedDirectories)) {
      throw new Error("cleanup quarantine inventory changed");
    }
    for (const fact of move.files) {
      const relativePath = relative(move.source, fact.path);
      const actual = await verifiedFile(
        projectRoot,
        location,
        resolve(location, relativePath)
      );
      if (actual.fact.size !== fact.size || actual.fact.sha256 !== fact.sha256) {
        throw new Error("cleanup quarantine file content changed");
      }
    }
  }

  async #removeEmptyQuarantine(
    run: NonNullable<ReturnType<CoreStore["getGitRun"]>>,
    intent: CleanupIntent
  ): Promise<void> {
    const intentRoot = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      run.runId,
      "cleanup",
      intent.intentId
    );
    for (const directory of [resolve(intentRoot, "objects"), intentRoot]) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (!isMissing(error) && (!(error instanceof Error) || !("code" in error)
          || (error as NodeJS.ErrnoException).code !== "ENOTEMPTY")) throw error;
      }
    }
  }

  #recordIntentTerminal(
    type: "git.cleanup.completed" | "git.cleanup.rolled_back",
    intent: CleanupIntent
  ): void {
    this.#store.insertEvent({
      id: randomUUID(),
      type,
      actorId: this.#actorId,
      taskId: null,
      causationEventId: null,
      payload: { runId: intent.runId, intentId: intent.intentId }
    });
  }

  async #verifyEvidence(run: NonNullable<ReturnType<CoreStore["getGitRun"]>>): Promise<VerifiedEvidence> {
    const runRoot = resolve(
      run.projectRoot,
      ".agenttown",
      "runs",
      run.runId
    );
    const reviewsRoot = resolve(runRoot, "reviews");
    const validationRoot = resolve(runRoot, "validation");
    const reviewPackages = this.#store.listReviewPackages(run.runId)
      .filter(({ status }) => status !== "deleted");
    const validationById = new Map<string, ValidationRunRecord>();
    const roots = new Set<string>();
    const fileFacts = new Map<string, VerifiedFile>();
    const directoryInventories = new Map<string, string[]>();

    for (const record of reviewPackages) {
      if (record.status === "tampered") {
        throw new Error(`review package is marked tampered: ${record.taskId}`);
      }
      const packageRoot = resolve(
        reviewsRoot,
        record.taskId,
        String(record.revision)
      );
      const manifestPath = resolve(packageRoot, "manifest.json");
      if (pathKey(record.manifestPath) !== pathKey(manifestPath)) {
        throw new Error(`review package path differs from durable identity: ${record.taskId}`);
      }
      await assertSafeTree(run.projectRoot, packageRoot);
      const inventory = await exactTreeInventory(run.projectRoot, packageRoot);
      directoryInventories.set(pathKey(packageRoot), inventory.directories);
      const manifestFile = await verifiedFile(run.projectRoot, packageRoot, manifestPath);
      if (manifestFile.fact.sha256 !== record.manifestHash) {
        throw new Error(`review package manifest hash mismatch: ${record.taskId}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(manifestFile.bytes.toString("utf8"));
      } catch {
        throw new Error(`review package manifest is not JSON: ${record.taskId}`);
      }
      if (!isRecord(parsed) || !isRecord(parsed.files)
        || parsed.schemaVersion !== 1 || parsed.runId !== run.runId
        || parsed.taskId !== record.taskId || parsed.revision !== record.revision
        || !Number.isSafeInteger(parsed.totalFiles)
        || !Number.isSafeInteger(parsed.totalBytes)) {
        throw new Error(`review package manifest identity changed: ${record.taskId}`);
      }
      const manifest = parsed as unknown as EvidenceManifest;
      const entries = Object.entries(manifest.files)
        .sort(([left], [right]) => left.localeCompare(right, "en"));
      if (manifest.totalFiles !== entries.length) {
        throw new Error(`review package manifest file total changed: ${record.taskId}`);
      }
      const expectedFiles = new Set<string>(["manifest.json"]);
      const expectedDirectories = new Set<string>(["validation"]);
      let payloadBytes = 0;
      const packageFiles = new Map<string, { fact: VerifiedFile; bytes: Buffer }>();
      for (const [relativePath, expected] of entries) {
        if (!safeManifestPath(relativePath) || !isRecord(expected)
          || !Number.isSafeInteger(expected.size) || (expected.size as number) < 0
          || typeof expected.sha256 !== "string"
          || !/^[0-9a-f]{64}$/u.test(expected.sha256)) {
          throw new Error(`review package manifest contains an unsafe entry: ${record.taskId}`);
        }
        expectedFiles.add(relativePath);
        const segments = relativePath.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          expectedDirectories.add(segments.slice(0, index).join("/"));
        }
        const absolute = resolve(packageRoot, ...segments);
        const verified = await verifiedFile(run.projectRoot, packageRoot, absolute);
        if (verified.fact.size !== expected.size
          || verified.fact.sha256 !== expected.sha256) {
          throw new Error(`review package file content changed: ${relativePath}`);
        }
        payloadBytes += verified.fact.size;
        packageFiles.set(relativePath, verified);
        fileFacts.set(pathKey(verified.fact.path), verified.fact);
      }
      if (inventory.files.length !== expectedFiles.size
        || inventory.files.some((path) => !expectedFiles.has(path))
        || inventory.directories.length !== expectedDirectories.size
        || inventory.directories.some((path) => !expectedDirectories.has(path))) {
        throw new Error(`review package inventory contains foreign paths: ${record.taskId}`);
      }
      if (payloadBytes !== manifest.totalBytes
        || record.totalBytes !== payloadBytes + manifestFile.bytes.length) {
        throw new Error(`review package byte totals changed: ${record.taskId}`);
      }
      fileFacts.set(pathKey(manifestFile.fact.path), manifestFile.fact);

      const validationJsonPaths = [...packageFiles.keys()]
        .filter((path) => /^validation\/[^/]+\.json$/u.test(path));
      const validationLogPaths = new Set([...packageFiles.keys()]
        .filter((path) => /^validation\/[^/]+\.log$/u.test(path)));
      for (const jsonPath of validationJsonPaths) {
        const commandId = jsonPath.slice("validation/".length, -".json".length);
        const logRelativePath = `validation/${commandId}.log`;
        const jsonFile = packageFiles.get(jsonPath)!;
        const packagedLog = packageFiles.get(logRelativePath);
        if (packagedLog === undefined) {
          throw new Error(`review package validation log is absent: ${commandId}`);
        }
        validationLogPaths.delete(logRelativePath);
        let validation: unknown;
        try {
          validation = JSON.parse(jsonFile.bytes.toString("utf8"));
        } catch {
          throw new Error(`review package validation record is not JSON: ${commandId}`);
        }
        if (!isRecord(validation)
          || typeof validation.validationId !== "string"
          || !/^[A-Za-z0-9_-]+$/u.test(validation.validationId)
          || !isRecord(validation.command)
          || validation.command.id !== commandId) {
          throw new Error(`review package validation identity changed: ${commandId}`);
        }
        const durable = this.#store.getValidationRun(validation.validationId);
        if (durable === null || durable.runId !== run.runId
          || durable.taskId !== record.taskId || durable.integrationAttemptId !== null
          || !sameJson(durable, validation)) {
          throw new Error(`review package validation is not an exact durable fact: ${commandId}`);
        }
        const expectedLogPath = resolve(
          validationRoot,
          `${durable.validationId}.log`
        );
        if (pathKey(durable.logPath) !== pathKey(expectedLogPath)) {
          throw new Error(`validation log path differs from durable identity: ${commandId}`);
        }
        await assertSafeTree(run.projectRoot, validationRoot);
        const originalLog = await verifiedFile(
          run.projectRoot,
          validationRoot,
          expectedLogPath
        );
        if (originalLog.fact.sha256 !== durable.logHash
          || packagedLog.fact.sha256 !== durable.logHash) {
          throw new Error(`validation log content differs from durable hash: ${commandId}`);
        }
        const prior = validationById.get(durable.validationId);
        if (prior !== undefined && !sameJson(prior, durable)) {
          throw new Error(`validation identity differs across review packages: ${durable.validationId}`);
        }
        validationById.set(durable.validationId, durable);
        roots.add(resolve(expectedLogPath));
        fileFacts.set(pathKey(originalLog.fact.path), originalLog.fact);
      }
      if (validationLogPaths.size !== 0) {
        throw new Error(`review package contains an unbound validation log: ${record.taskId}`);
      }
      roots.add(packageRoot);
    }
    const sortedRoots = [...roots].sort((left, right) => left.localeCompare(right, "en"));
    const sortedFiles = [...fileFacts.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"));
    return {
      reviewPackages: [...reviewPackages].sort((left, right) =>
        left.taskId.localeCompare(right.taskId, "en") || left.revision - right.revision),
      validationRuns: [...validationById.values()].sort((left, right) =>
        left.validationId.localeCompare(right.validationId, "en")),
      roots: sortedRoots,
      files: sortedFiles,
      inventories: sortedRoots.map((root) => {
        const directories = directoryInventories.get(pathKey(root));
        return directories === undefined
          ? {
              path: root,
              kind: "file" as const,
              files: sortedFiles.filter((fact) => pathKey(fact.path) === pathKey(root)),
              directories: []
            }
          : {
              path: root,
              kind: "directory" as const,
              files: sortedFiles.filter((fact) => isWithin(root, fact.path)),
              directories: [...directories]
            };
      })
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
