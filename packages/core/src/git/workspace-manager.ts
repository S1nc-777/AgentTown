import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve
} from "node:path";
import type {
  GitRunRecord,
  GitWorkspaceRecord,
  GitWorkspaceStatus
} from "@agenttown/runtime-contract";
import { CoreStore, type NewEvent } from "../storage/core-store.js";
import { GitCommandRunner } from "./git-command.js";
import type { RepositoryBaseline } from "./repository-preflight.js";

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_-]*$/u;
const OBJECT_ID = /^[0-9a-f]+$/u;

interface GitRunner {
  run: GitCommandRunner["run"];
}

interface WorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
}

export interface WorkspaceManagerOptions {
  store: CoreStore;
  companyId: string;
  actorId?: string;
  git?: GitRunner;
}

export interface CreateTaskWorkspaceInput {
  runId: string;
  employeeId: string;
  taskId: string;
  baseCommit: string;
}

export interface CreateCandidateWorkspaceInput {
  runId: string;
  attemptId: string;
  baseCommit: string;
}

class WorkspaceTamperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceTamperError";
  }
}

function identifier(value: string, label: string): string {
  if (
    !SAFE_IDENTIFIER.test(value)
    || value.length > 128
  ) {
    throw new TypeError(
      `${label} must be a lowercase identifier segment`
    );
  }
  return value;
}

function objectId(value: string, length: number, label: string): string {
  if (
    (length !== 40 && length !== 64)
    || value.length !== length
    || !OBJECT_ID.test(value)
  ) {
    throw new TypeError(`${label} must be a ${length}-character Git object id`);
  }
  return value;
}

export function integrationRef(runId: string): string {
  return `refs/heads/agenttown/${identifier(runId, "run id")}/integration`;
}

export function taskRef(
  runId: string,
  employeeId: string,
  taskId: string
): string {
  return [
    "refs/heads/agenttown",
    identifier(runId, "run id"),
    "tasks",
    identifier(employeeId, "employee id"),
    identifier(taskId, "task id")
  ].join("/");
}

export function candidateRef(runId: string, attemptId: string): string {
  return [
    "refs/heads/agenttown",
    identifier(runId, "run id"),
    "candidates",
    identifier(attemptId, "attempt id")
  ].join("/");
}

function branchName(ref: string): string {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) {
    throw new TypeError("workspace branch ref must be under refs/heads");
  }
  return ref.slice(prefix.length);
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertNoPathRedirect(
  projectRoot: string,
  target: string
): Promise<void> {
  const resolvedProjectRoot = resolve(projectRoot);
  const resolvedTarget = resolve(target);
  if (!isWithin(resolvedProjectRoot, resolvedTarget)) {
    throw new WorkspaceTamperError("workspace path escaped the project root");
  }

  const projectRealPath = await realpath(resolvedProjectRoot);
  const segments = relative(resolvedProjectRoot, resolvedTarget)
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
  let current = resolvedProjectRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new WorkspaceTamperError(
        `workspace path contains a symbolic link or reparse point: ${segment}`
      );
    }
    if (!metadata.isDirectory()) {
      throw new WorkspaceTamperError(
        `workspace path contains a non-directory component: ${segment}`
      );
    }
    const currentRealPath = await realpath(current);
    if (!isWithin(projectRealPath, currentRealPath)) {
      throw new WorkspaceTamperError(
        "workspace path contains a reparse escape"
      );
    }
  }
}

async function assertWorkspaceLocation(
  projectRoot: string,
  runRoot: string,
  workspacePath: string
): Promise<void> {
  const resolvedRunRoot = resolve(runRoot);
  const resolvedWorkspacePath = resolve(workspacePath);
  if (
    resolvedWorkspacePath === resolvedRunRoot
    || !isWithin(resolvedRunRoot, resolvedWorkspacePath)
  ) {
    throw new WorkspaceTamperError(
      "workspace path escaped the exact run worktree root"
    );
  }
  await assertNoPathRedirect(projectRoot, resolvedWorkspacePath);
}

async function assertWorkspacePath(
  projectRoot: string,
  runRoot: string,
  workspacePath: string
): Promise<void> {
  await assertWorkspaceLocation(projectRoot, runRoot, workspacePath);
  const resolvedRunRoot = resolve(runRoot);
  const resolvedWorkspacePath = resolve(workspacePath);
  const runRootRealPath = await realpath(resolvedRunRoot);
  const workspaceRealPath = await realpath(resolvedWorkspacePath);
  if (!isWithin(runRootRealPath, workspaceRealPath)) {
    throw new WorkspaceTamperError(
      "workspace real path escaped the exact run worktree root"
    );
  }
}

function parseWorktrees(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of output.replace(/\r\n?/gu, "\n").split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const separator = line.indexOf(" ");
      if (separator > 0) {
        fields.set(line.slice(0, separator), line.slice(separator + 1));
      } else if (line.length > 0) {
        fields.set(line, "");
      }
    }
    const path = fields.get("worktree");
    const head = fields.get("HEAD");
    if (path === undefined || head === undefined) continue;
    entries.push({
      path: resolve(path),
      head,
      branchRef: fields.get("branch") ?? null
    });
  }
  if (entries.length === 0) {
    throw new Error("Git worktree porcelain protocol returned no worktrees");
  }
  return entries;
}

function workspaceEvent(
  type: string,
  actorId: string,
  workspace: GitWorkspaceRecord
): NewEvent {
  return {
    id: randomUUID(),
    type,
    actorId,
    taskId: workspace.taskId,
    causationEventId: null,
    payload: {
      runId: workspace.runId,
      workspaceId: workspace.workspaceId,
      kind: workspace.kind,
      branchRef: workspace.branchRef,
      headCommit: workspace.headCommit
    }
  };
}

function sameRun(left: GitRunRecord | null, right: GitRunRecord): boolean {
  return left !== null
    && left.runId === right.runId
    && left.companyId === right.companyId
    && left.projectRoot === right.projectRoot
    && left.originalBranch === right.originalBranch
    && left.baseCommit === right.baseCommit
    && left.integrationRef === right.integrationRef
    && left.integrationCommit === right.integrationCommit
    && left.status === right.status
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameWorkspace(
  left: GitWorkspaceRecord | null,
  right: GitWorkspaceRecord
): boolean {
  return left !== null
    && left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.taskId === right.taskId
    && left.employeeId === right.employeeId
    && left.kind === right.kind
    && left.path === right.path
    && left.branchRef === right.branchRef
    && left.baseCommit === right.baseCommit
    && left.headCommit === right.headCommit
    && left.status === right.status;
}

function sameEvent(left: NewEvent | undefined, right: NewEvent): boolean {
  return left !== undefined
    && left.id === right.id
    && left.type === right.type
    && left.actorId === right.actorId
    && left.taskId === right.taskId
    && left.causationEventId === right.causationEventId
    && JSON.stringify(left.payload) === JSON.stringify(right.payload);
}

export class WorkspaceManager {
  readonly #store: CoreStore;
  readonly #companyId: string;
  readonly #actorId: string;
  readonly #git: GitRunner;

  constructor(options: WorkspaceManagerOptions) {
    this.#store = options.store;
    this.#companyId = identifier(options.companyId, "company id");
    this.#actorId = options.actorId ?? "core";
    this.#git = options.git ?? new GitCommandRunner();
  }

  async createRun(
    runId: string,
    baseline: RepositoryBaseline
  ): Promise<GitRunRecord> {
    const validatedRunId = identifier(runId, "run id");
    if (this.#store.getGitRun(validatedRunId) !== null) {
      throw new Error(`Git run already exists: ${validatedRunId}`);
    }
    if (!isAbsolute(baseline.projectRoot)) {
      throw new TypeError("repository baseline project root must be absolute");
    }
    objectId(
      baseline.baseCommit,
      baseline.objectIdLength,
      "repository baseline commit"
    );

    const projectRoot = resolve(baseline.projectRoot);
    const ref = integrationRef(validatedRunId);
    const runRoot = this.#runRoot(projectRoot, validatedRunId);
    const workspacePath = resolve(runRoot, "integration");
    const now = new Date().toISOString();
    const intent: GitRunRecord = {
      runId: validatedRunId,
      companyId: this.#companyId,
      projectRoot,
      originalBranch: baseline.originalBranch,
      baseCommit: baseline.baseCommit,
      integrationRef: ref,
      integrationCommit: baseline.baseCommit,
      status: "creating",
      createdAt: now,
      updatedAt: now
    };
    const integrationIntent: GitWorkspaceRecord = {
      workspaceId: `${validatedRunId}:integration`,
      runId: validatedRunId,
      taskId: null,
      employeeId: null,
      kind: "integration",
      path: workspacePath,
      branchRef: ref,
      baseCommit: baseline.baseCommit,
      headCommit: baseline.baseCommit,
      status: "missing"
    };
    this.#store.putGitRun(intent);

    let pathOwned = false;
    let refOwned = false;
    try {
      await assertNoPathRedirect(projectRoot, workspacePath);
      await this.#assertPathAbsent(workspacePath);
      await this.#assertRefAbsent(projectRoot, ref);
      await this.#assertCommit(projectRoot, baseline.baseCommit);
      await mkdir(runRoot, { recursive: true });
      await assertNoPathRedirect(projectRoot, workspacePath);
      await this.#git.run([
        "worktree",
        "add",
        "-b",
        branchName(ref),
        "--",
        workspacePath,
        baseline.baseCommit
      ], { cwd: projectRoot });
      pathOwned = true;
      refOwned = true;

      const integrationWorkspace: GitWorkspaceRecord = {
        ...integrationIntent,
        status: "active"
      };
      await assertWorkspacePath(projectRoot, runRoot, workspacePath);
      await this.#verifyWorkspace(projectRoot, integrationWorkspace);

      const activeRun: GitRunRecord = {
        ...intent,
        status: "active",
        updatedAt: new Date().toISOString()
      };
      const createdEvent: NewEvent = {
        id: randomUUID(),
        type: "git.run.created",
        actorId: this.#actorId,
        taskId: null,
        causationEventId: null,
        payload: {
          runId: validatedRunId,
          integrationRef: ref,
          integrationCommit: baseline.baseCommit,
          workspaceId: integrationWorkspace.workspaceId
        }
      };
      this.#commitRunCreationDurably(
        activeRun,
        integrationWorkspace,
        createdEvent
      );
      return activeRun;
    } catch (error) {
      const cleaned = await this.#cleanupPartial({
        projectRoot,
        runRoot,
        path: workspacePath,
        ref,
        head: baseline.baseCommit,
        pathOwned,
        refOwned
      });
      const failedRun: GitRunRecord = {
        ...intent,
        status: error instanceof WorkspaceTamperError || !cleaned
          ? "tampered"
          : "creating",
        updatedAt: new Date().toISOString()
      };
      this.#store.putGitRun(failedRun);
      if (cleaned) {
        this.#commitWorkspaceDurably(
          integrationIntent,
          workspaceEvent(
            "git.workspace.removed",
            this.#actorId,
            integrationIntent
          )
        );
      }
      throw error;
    }
  }

  async createTaskWorkspace(
    input: CreateTaskWorkspaceInput
  ): Promise<GitWorkspaceRecord> {
    const runId = identifier(input.runId, "run id");
    const employeeId = identifier(input.employeeId, "employee id");
    const taskId = identifier(input.taskId, "task id");
    return this.#createWorkspace({
      runId,
      taskId,
      employeeId,
      kind: "task",
      workspaceId: `${runId}:task:${employeeId}:${taskId}`,
      pathSegments: ["tasks", employeeId, taskId],
      ref: taskRef(runId, employeeId, taskId),
      baseCommit: input.baseCommit
    });
  }

  async createCandidateWorkspace(
    input: CreateCandidateWorkspaceInput
  ): Promise<GitWorkspaceRecord> {
    const runId = identifier(input.runId, "run id");
    const attemptId = identifier(input.attemptId, "attempt id");
    return this.#createWorkspace({
      runId,
      taskId: null,
      employeeId: null,
      kind: "candidate",
      workspaceId: `${runId}:candidate:${attemptId}`,
      pathSegments: ["candidates", attemptId],
      ref: candidateRef(runId, attemptId),
      baseCommit: input.baseCommit
    });
  }

  async pauseRun(runId: string): Promise<void> {
    const validatedRunId = identifier(runId, "run id");
    const run = this.#requiredRun(validatedRunId);
    if (run.status === "paused") return;
    if (run.status !== "active") {
      throw new Error(`Git run cannot be paused from status ${run.status}`);
    }
    const updatedAt = new Date().toISOString();
    const pausedRun: GitRunRecord = {
      ...run,
      status: "paused",
      updatedAt
    };
    const pausedWorkspaces = this.#store.listGitWorkspaces(validatedRunId).map(
      (workspace): GitWorkspaceRecord => workspace.status === "active"
        ? { ...workspace, status: "paused" }
        : workspace
    );
    const pausedEvent: NewEvent = {
      id: randomUUID(),
      type: "git.run.paused",
      actorId: this.#actorId,
      taskId: null,
      causationEventId: null,
      payload: { runId: validatedRunId }
    };
    try {
      this.#store.commitGitRunPause({
        run: pausedRun,
        workspaces: pausedWorkspaces,
        event: pausedEvent
      });
    } catch (error) {
      if (!this.#pauseIsDurable(pausedRun, pausedWorkspaces, pausedEvent)) {
        throw error;
      }
    }
  }

  async removeVerifiedWorkspace(workspaceId: string): Promise<void> {
    if (workspaceId.length === 0 || workspaceId.length > 512) {
      throw new TypeError("workspace id must be non-empty");
    }
    const workspace = this.#store.getGitWorkspace(workspaceId);
    if (workspace === null) {
      throw new Error(`Git workspace not found: ${workspaceId}`);
    }
    const run = this.#requiredRun(workspace.runId);
    if (workspace.status === "missing") return;
    if (
      workspace.status !== "completed"
      && workspace.status !== "paused"
      && workspace.status !== "removing"
    ) {
      throw new Error("Git workspace must be completed or paused before cleanup");
    }
    const runRoot = this.#runRoot(run.projectRoot, run.runId);
    if (!await pathExists(workspace.path)) {
      try {
        await assertWorkspaceLocation(
          run.projectRoot,
          runRoot,
          workspace.path
        );
      } catch (error) {
        if (error instanceof WorkspaceTamperError) {
          this.#persistWorkspaceTampered(workspace);
        }
        throw error;
      }
      await this.#removeMissingWorkspace(run, workspace);
      return;
    }
    try {
      await assertWorkspacePath(run.projectRoot, runRoot, workspace.path);
      await this.#verifyWorkspace(run.projectRoot, workspace);
    } catch (error) {
      if (error instanceof WorkspaceTamperError) {
        this.#persistWorkspaceTampered(workspace);
      }
      throw error;
    }
    const dirty = await this.#git.run([
      "status",
      "--porcelain=v2",
      "--untracked-files=all"
    ], { cwd: workspace.path });
    if (dirty.stdout.length !== 0) {
      throw new Error("Git workspace has uncommitted changes");
    }

    const removingWorkspace = this.#prepareWorkspaceRemoval(workspace);
    await this.#git.run(
      ["worktree", "remove", "--", workspace.path],
      { cwd: run.projectRoot }
    );
    try {
      const entriesAfter = await this.#listWorktrees(run.projectRoot);
      if (entriesAfter.some((entry) =>
        pathKey(entry.path) === pathKey(workspace.path)
      )) {
        throw new WorkspaceTamperError("Git worktree removal could not be verified");
      }
      const branchHead = await this.#readRef(run.projectRoot, workspace.branchRef);
      if (branchHead !== workspace.headCommit) {
        throw new WorkspaceTamperError(
          "workspace branch ref changed during worktree cleanup"
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceTamperError) {
        this.#persistWorkspaceTampered(removingWorkspace);
      }
      throw error;
    }
    const removedWorkspace: GitWorkspaceRecord = {
      ...removingWorkspace,
      status: "missing"
    };
    this.#commitWorkspaceDurably(
      removedWorkspace,
      workspaceEvent(
        "git.workspace.removed",
        this.#actorId,
        removedWorkspace
      )
    );
  }

  async #createWorkspace(input: {
    runId: string;
    taskId: string | null;
    employeeId: string | null;
    kind: "task" | "candidate";
    workspaceId: string;
    pathSegments: readonly string[];
    ref: string;
    baseCommit: string;
  }): Promise<GitWorkspaceRecord> {
    const run = this.#requiredRun(input.runId);
    if (run.status !== "active") {
      throw new Error(`Git run is not active: ${input.runId}`);
    }
    if (this.#store.getGitWorkspace(input.workspaceId) !== null) {
      throw new Error(`Git workspace already exists: ${input.workspaceId}`);
    }
    objectId(input.baseCommit, run.baseCommit.length, "workspace base commit");
    const runRoot = this.#runRoot(run.projectRoot, run.runId);
    const workspacePath = resolve(runRoot, ...input.pathSegments);
    const intent: GitWorkspaceRecord = {
      workspaceId: input.workspaceId,
      runId: input.runId,
      taskId: input.taskId,
      employeeId: input.employeeId,
      kind: input.kind,
      path: workspacePath,
      branchRef: input.ref,
      baseCommit: input.baseCommit,
      headCommit: input.baseCommit,
      status: "missing"
    };
    this.#store.putGitWorkspace(intent);

    let pathOwned = false;
    let refOwned = false;
    try {
      await assertNoPathRedirect(run.projectRoot, workspacePath);
      await this.#assertPathAbsent(workspacePath);
      await this.#assertRefAbsent(run.projectRoot, input.ref);
      await this.#assertCommit(run.projectRoot, input.baseCommit);
      await mkdir(runRoot, { recursive: true });
      await assertNoPathRedirect(run.projectRoot, workspacePath);
      await this.#git.run([
        "worktree",
        "add",
        "-b",
        branchName(input.ref),
        "--",
        workspacePath,
        input.baseCommit
      ], { cwd: run.projectRoot });
      pathOwned = true;
      refOwned = true;

      const active: GitWorkspaceRecord = {
        ...intent,
        status: "active"
      };
      await assertWorkspacePath(run.projectRoot, runRoot, workspacePath);
      await this.#verifyWorkspace(run.projectRoot, active);
      const createdEvent = workspaceEvent(
        "git.workspace.created",
        this.#actorId,
        active
      );
      this.#commitWorkspaceDurably(active, createdEvent);
      return active;
    } catch (error) {
      const cleaned = await this.#cleanupPartial({
        projectRoot: run.projectRoot,
        runRoot,
        path: workspacePath,
        ref: input.ref,
        head: input.baseCommit,
        pathOwned,
        refOwned
      });
      const status: GitWorkspaceStatus =
        error instanceof WorkspaceTamperError || !cleaned
          ? "tampered"
          : "missing";
      const rolledBack = { ...intent, status };
      if (cleaned) {
        this.#commitWorkspaceDurably(
          rolledBack,
          workspaceEvent(
            "git.workspace.removed",
            this.#actorId,
            rolledBack
          )
        );
      } else {
        this.#store.putGitWorkspace(rolledBack);
      }
      throw error;
    }
  }

  #requiredRun(runId: string): GitRunRecord {
    const run = this.#store.getGitRun(runId);
    if (run === null) throw new Error(`Git run not found: ${runId}`);
    if (run.companyId !== this.#companyId) {
      throw new Error(
        `Git run company ownership mismatch: ${runId}`
      );
    }
    return run;
  }

  #prepareWorkspaceRemoval(
    workspace: GitWorkspaceRecord
  ): GitWorkspaceRecord {
    if (workspace.status === "removing") return workspace;
    const removing: GitWorkspaceRecord = {
      ...workspace,
      status: "removing"
    };
    this.#commitWorkspaceDurably(
      removing,
      workspaceEvent(
        "git.workspace.removal_prepared",
        this.#actorId,
        removing
      )
    );
    return removing;
  }

  async #removeMissingWorkspace(
    run: GitRunRecord,
    workspace: GitWorkspaceRecord
  ): Promise<void> {
    const entries = await this.#listWorktrees(run.projectRoot);
    const matching = entries.filter(
      (entry) => pathKey(entry.path) === pathKey(workspace.path)
    );
    const branchHead = await this.#readRef(
      run.projectRoot,
      workspace.branchRef
    );
    const exactEntry = matching.length === 1
      && matching[0]?.branchRef === workspace.branchRef
      && matching[0]?.head === workspace.headCommit;
    if (
      matching.length > 1
      || (matching.length === 1 && !exactEntry)
      || branchHead !== workspace.headCommit
    ) {
      const error = new WorkspaceTamperError(
        "missing workspace metadata contradicted persisted branch ref or head facts"
      );
      this.#persistWorkspaceTampered(workspace);
      throw error;
    }

    const removing = this.#prepareWorkspaceRemoval(workspace);
    if (exactEntry) {
      await this.#git.run(
        ["worktree", "remove", "--force", "--", workspace.path],
        { cwd: run.projectRoot }
      );
    }
    const entriesAfter = await this.#listWorktrees(run.projectRoot);
    if (entriesAfter.some(
      (entry) => pathKey(entry.path) === pathKey(workspace.path)
    )) {
      const error = new WorkspaceTamperError(
        "stale Git worktree metadata removal could not be verified"
      );
      this.#persistWorkspaceTampered(removing);
      throw error;
    }
    if (
      await this.#readRef(run.projectRoot, workspace.branchRef)
      !== workspace.headCommit
    ) {
      const error = new WorkspaceTamperError(
        "workspace branch ref changed during stale metadata cleanup"
      );
      this.#persistWorkspaceTampered(removing);
      throw error;
    }
    const removed: GitWorkspaceRecord = {
      ...removing,
      status: "missing"
    };
    this.#commitWorkspaceDurably(
      removed,
      workspaceEvent("git.workspace.removed", this.#actorId, removed)
    );
  }

  #persistWorkspaceTampered(workspace: GitWorkspaceRecord): void {
    const tampered: GitWorkspaceRecord = {
      ...workspace,
      status: "tampered"
    };
    this.#commitWorkspaceDurably(
      tampered,
      workspaceEvent(
        "git.workspace.tampered",
        this.#actorId,
        tampered
      )
    );
  }

  #commitRunCreationDurably(
    run: GitRunRecord,
    workspace: GitWorkspaceRecord,
    event: NewEvent
  ): void {
    try {
      this.#store.commitGitRunCreation({ run, workspace, event });
    } catch (error) {
      const durable = sameRun(this.#store.getGitRun(run.runId), run)
      && sameWorkspace(
        this.#store.getGitWorkspace(workspace.workspaceId),
        workspace
      )
      && this.#eventIsDurable(event);
      if (!durable) throw error;
    }
  }

  #commitWorkspaceDurably(
    workspace: GitWorkspaceRecord,
    event: NewEvent
  ): void {
    try {
      this.#store.commitGitWorkspace({ workspace, event });
    } catch (error) {
      if (
        !sameWorkspace(
          this.#store.getGitWorkspace(workspace.workspaceId),
          workspace
        )
        || !this.#eventIsDurable(event)
      ) {
        throw error;
      }
    }
  }

  #pauseIsDurable(
    run: GitRunRecord,
    workspaces: readonly GitWorkspaceRecord[],
    event: NewEvent
  ): boolean {
    const persisted = this.#store.listGitWorkspaces(run.runId);
    return sameRun(this.#store.getGitRun(run.runId), run)
      && persisted.length === workspaces.length
      && workspaces.every((workspace) => sameWorkspace(
        persisted.find(({ workspaceId }) =>
          workspaceId === workspace.workspaceId
        ) ?? null,
        workspace
      ))
      && this.#eventIsDurable(event);
  }

  #eventIsDurable(event: NewEvent): boolean {
    return sameEvent(
      this.#store.listEvents(0).find(({ id }) => id === event.id),
      event
    );
  }

  #runRoot(projectRoot: string, runId: string): string {
    const root = resolve(
      projectRoot,
      ".agenttown",
      "worktrees",
      identifier(runId, "run id")
    );
    if (!isWithin(resolve(projectRoot), root)) {
      throw new WorkspaceTamperError("run worktree root escaped the project");
    }
    return root;
  }

  async #assertCommit(projectRoot: string, commit: string): Promise<void> {
    const result = await this.#git.run(
      ["rev-parse", "--verify", `${commit}^{commit}`],
      { cwd: projectRoot }
    );
    if (result.stdout.trim() !== commit) {
      throw new Error("Git resolved an unexpected workspace base commit");
    }
  }

  async #assertPathAbsent(path: string): Promise<void> {
    if (await pathExists(path)) {
      throw new WorkspaceTamperError("workspace intent path already exists");
    }
  }

  async #assertRefAbsent(projectRoot: string, ref: string): Promise<void> {
    const existingHead = await this.#readRef(projectRoot, ref);
    if (existingHead !== null) {
      throw new WorkspaceTamperError("workspace intent branch ref already exists");
    }
  }

  async #readRef(projectRoot: string, ref: string): Promise<string | null> {
    const result = await this.#git.run(
      ["rev-parse", "--verify", "--quiet", ref],
      { cwd: projectRoot, allowedExitCodes: [0, 1] }
    );
    if (result.exitCode === 1) return null;
    const head = result.stdout.trim();
    if (!OBJECT_ID.test(head) || (head.length !== 40 && head.length !== 64)) {
      throw new Error("Git returned an invalid branch object id");
    }
    return head;
  }

  async #listWorktrees(projectRoot: string): Promise<WorktreeEntry[]> {
    const result = await this.#git.run(
      ["worktree", "list", "--porcelain"],
      { cwd: projectRoot }
    );
    return parseWorktrees(result.stdout);
  }

  async #verifyWorkspace(
    projectRoot: string,
    workspace: GitWorkspaceRecord
  ): Promise<void> {
    const entries = await this.#listWorktrees(projectRoot);
    const matching = entries.filter(
      (entry) => pathKey(entry.path) === pathKey(workspace.path)
    );
    if (matching.length !== 1) {
      throw new WorkspaceTamperError(
        "Git worktree list did not contain the exact workspace path"
      );
    }
    const entry = matching[0];
    if (
      entry === undefined
      || entry.branchRef !== workspace.branchRef
      || entry.head !== workspace.headCommit
    ) {
      throw new WorkspaceTamperError(
        "Git worktree ref or head did not match persisted workspace facts"
      );
    }
    if (await this.#readRef(projectRoot, workspace.branchRef) !== workspace.headCommit) {
      throw new WorkspaceTamperError(
        "workspace branch ref did not match its recorded head"
      );
    }
  }

  async #cleanupPartial(input: {
    projectRoot: string;
    runRoot: string;
    path: string;
    ref: string;
    head: string;
    pathOwned: boolean;
    refOwned: boolean;
  }): Promise<boolean> {
    try {
      if (!input.pathOwned || !input.refOwned) return false;
      const pathPresent = await pathExists(input.path);
      const entries = await this.#listWorktrees(input.projectRoot);
      const matchingEntries = entries.filter(
        (candidate) => pathKey(candidate.path) === pathKey(input.path)
      );
      if (matchingEntries.length > 1) return false;
      const entry = matchingEntries[0];
      if (pathPresent) {
        if (
          entry === undefined
          || entry.branchRef !== input.ref
          || entry.head !== input.head
        ) {
          return false;
        }
        await assertWorkspacePath(
          input.projectRoot,
          input.runRoot,
          input.path
        );
        await this.#git.run(
          ["worktree", "remove", "--", input.path],
          { cwd: input.projectRoot }
        );
      } else if (entry !== undefined) {
        return false;
      }

      const currentHead = await this.#readRef(input.projectRoot, input.ref);
      if (currentHead === null) return true;
      if (currentHead !== input.head) return false;
      await this.#git.run(
        ["update-ref", "-d", input.ref, input.head],
        { cwd: input.projectRoot }
      );
      return await this.#readRef(input.projectRoot, input.ref) === null;
    } catch {
      return false;
    }
  }
}
