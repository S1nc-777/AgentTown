import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve
} from "node:path";
import type {
  CompanyDefinition,
  GitTaskSubmission,
  GitWorkspaceRecord,
  ValidationCommand,
  ValidationRunRecord
} from "@agenttown/runtime-contract";
import { parseGitTaskSubmission } from "@agenttown/runtime-contract";
import { CoreStore } from "../storage/core-store.js";
import { GitCommandRunner } from "./git-command.js";

const MAX_COMMITS = 10_000;
const MAX_COMMIT_FIELD_BYTES = 64 * 1024;
const MAX_VALIDATION_LOG_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;

export interface CanonicalCommit {
  id: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  subject: string;
  body: string;
}

export type EvidenceFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type_changed";

export interface EvidenceFile {
  path: string;
  oldPath: string | null;
  status: EvidenceFileStatus;
  oldMode: string;
  newMode: string;
  size: number;
  sha256: string;
  binary: boolean;
}

export interface SubmissionWarning {
  code: "patch_warning_limit_exceeded";
  actualBytes: number;
  warningBytes: number;
}

export interface AuthoritativeValidation {
  record: ValidationRunRecord;
  log: Buffer;
}

export interface ValidatedSubmission {
  schemaVersion: 1;
  submission: GitTaskSubmission;
  runId: string;
  taskId: string;
  workspaceId: string;
  employeeId: string;
  branchRef: string;
  baseCommit: string;
  headCommit: string;
  commits: CanonicalCommit[];
  files: EvidenceFile[];
  patch: string;
  patchBytes: number;
  warnings: SubmissionWarning[];
  changeSummary: string;
  knownRisks: string[];
  reportedResults: GitTaskSubmission["reportedResults"];
  validations: AuthoritativeValidation[];
}

export interface SubmissionValidatorOptions {
  store: CoreStore;
  companyId: string;
}

interface RawChange {
  oldMode: string;
  newMode: string;
  oldObject: string;
  newObject: string;
  code: string;
  path: string;
  oldPath: string | null;
}

interface Numstat {
  added: string;
  deleted: string;
  path: string;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
}

function isWithin(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function pathKey(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameWorkspace(left: GitWorkspaceRecord, right: GitWorkspaceRecord): boolean {
  return left.workspaceId === right.workspaceId
    && left.runId === right.runId
    && left.taskId === right.taskId
    && left.employeeId === right.employeeId
    && left.kind === right.kind
    && pathKey(left.path) === pathKey(right.path)
    && left.branchRef === right.branchRef
    && left.baseCommit === right.baseCommit
    && left.headCommit === right.headCommit
    && left.status === right.status;
}

function sameCommand(left: ValidationCommand, right: ValidationCommand): boolean {
  return left.id === right.id
    && left.executable === right.executable
    && left.cwd === right.cwd
    && left.timeoutSeconds === right.timeoutSeconds
    && left.args.length === right.args.length
    && left.args.every((value, index) => value === right.args[index]);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
}

/**
 * Workspace identities are composite keys produced by the WorkspaceManager
 * (`<runId>:task:<employeeId>:<taskId>` or `<runId>:candidate:<attemptId>`),
 * so they allow colon-separated safe segments. The identity is an opaque
 * durable key and is never used as a filesystem path component.
 */
function assertWorkspaceIdentifier(value: string, label: string): void {
  if (
    value.length === 0
    || value.length > 512
    || !/^[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)*$/u.test(value)
  ) {
    throw new TypeError(`${label} must be a safe workspace identifier`);
  }
}

function companyDefinition(store: CoreStore, companyId: string): CompanyDefinition {
  const company = store.getCompany(companyId);
  if (
    company === null
    || (company.status !== "active" && company.status !== "running")
  ) {
    throw new Error("submission company is not active");
  }
  const value = JSON.parse(company.definitionJson) as CompanyDefinition;
  const warning = value.evidence?.diffWarningBytes;
  const hard = value.evidence?.diffHardLimitBytes;
  if (!Number.isSafeInteger(warning) || !Number.isSafeInteger(hard)
    || warning < 256 * 1024 || hard < 1024 * 1024
    || hard > MAX_EVIDENCE_BYTES || warning > hard) {
    throw new Error("persisted company evidence limits are invalid");
  }
  return value;
}

async function assertSafeDirectory(
  projectRoot: string,
  workspacePath: string
): Promise<DirectoryIdentity> {
  const root = resolve(projectRoot);
  const target = resolve(workspacePath);
  if (!isWithin(root, target)) throw new Error("workspace path escaped project root");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("workspace project root contains a symbolic link or reparse point");
  }
  const rootReal = await realpath(root);
  let current = root;
  for (const segment of relative(root, target).split(/[\\/]/u)) {
    if (segment.length === 0) continue;
    current = resolve(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("workspace path contains a symbolic link, reparse point, or non-directory");
    }
    if (!isWithin(rootReal, await realpath(current))) {
      throw new Error("workspace path contains a reparse escape");
    }
  }
  const metadata = await lstat(target);
  return {
    path: target,
    realPath: await realpath(target),
    device: metadata.dev,
    inode: metadata.ino
  };
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return pathKey(left.path) === pathKey(right.path)
    && pathKey(left.realPath) === pathKey(right.realPath)
    && left.device === right.device
    && left.inode === right.inode;
}

function parseRawChanges(output: string): RawChange[] {
  const tokens = output.split("\0");
  const changes: RawChange[] = [];
  let index = 0;
  while (tokens[index] !== undefined && tokens[index] !== "") {
    const header = tokens[index++]!;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/u.exec(header);
    if (match === null) throw new Error("Git returned malformed raw diff metadata");
    const firstPath = tokens[index++];
    if (firstPath === undefined || firstPath.length === 0 || firstPath.includes("\uFFFD")) {
      throw new Error("Git returned an unsafe diff path");
    }
    const code = match[5]!;
    const secondPath = code === "R" || code === "C" ? tokens[index++] : undefined;
    if ((code === "R" || code === "C")
      && (secondPath === undefined || secondPath.length === 0 || secondPath.includes("\uFFFD"))) {
      throw new Error("Git returned an unsafe renamed diff path");
    }
    changes.push({
      oldMode: match[1]!,
      newMode: match[2]!,
      oldObject: match[3]!,
      newObject: match[4]!,
      code,
      path: secondPath ?? firstPath,
      oldPath: secondPath === undefined ? null : firstPath
    });
  }
  return changes;
}

function parseNumstat(output: string): Map<string, Numstat> {
  const tokens = output.split("\0");
  const rows = new Map<string, Numstat>();
  let index = 0;
  while (tokens[index] !== undefined && tokens[index] !== "") {
    const header = tokens[index++]!;
    const match = /^([0-9-]+)\t([0-9-]+)\t(.*)$/u.exec(header);
    if (match === null) throw new Error("Git returned malformed numstat metadata");
    let path = match[3]!;
    if (path === "") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (oldPath === undefined || newPath === undefined || newPath.length === 0) {
        throw new Error("Git returned malformed rename numstat metadata");
      }
      path = newPath;
    }
    rows.set(path, { added: match[1]!, deleted: match[2]!, path });
  }
  return rows;
}

function status(code: string): EvidenceFileStatus {
  switch (code) {
    case "A": return "added";
    case "M": return "modified";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "T": return "type_changed";
    default: throw new Error(`unsupported Git change status: ${code}`);
  }
}

function assertBoundedField(value: string, label: string): string {
  if (Buffer.byteLength(value, "utf8") > MAX_COMMIT_FIELD_BYTES) {
    throw new Error(`${label} exceeds the canonical metadata limit`);
  }
  return value;
}

async function hashBlob(
  cwd: string,
  objectId: string,
  maxBytes: number
): Promise<{ size: number; sha256: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["cat-file", "blob", objectId], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        LANG: "C",
        LC_ALL: "C"
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const hash = createHash("sha256");
    let size = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        return;
      }
      hash.update(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk.slice(0, 2_000 - stderr.length);
    });
    child.once("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (size > maxBytes) {
        reject(new Error(`Git blob exceeds configured evidence hard limit: ${maxBytes}`));
      } else if (code !== 0) {
        reject(new Error(`git cat-file failed: ${stderr.trim()}`));
      } else {
        resolvePromise({ size, sha256: hash.digest("hex") });
      }
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

export class SubmissionValidator {
  readonly #store: CoreStore;
  readonly #companyId: string;

  constructor(options: SubmissionValidatorOptions) {
    this.#store = options.store;
    this.#companyId = options.companyId;
  }

  async validate(
    workspaceInput: GitWorkspaceRecord,
    submission: GitTaskSubmission
  ): Promise<ValidatedSubmission> {
    submission = parseGitTaskSubmission(submission);
    const registered = this.#store.getGitWorkspace(workspaceInput.workspaceId);
    const run = this.#store.getGitRun(workspaceInput.runId);
    if (registered === null || run === null || !sameWorkspace(registered, workspaceInput)) {
      throw new Error("submission workspace does not match its registered facts");
    }
    if (run.runId !== registered.runId || run.companyId !== this.#companyId
      || run.status !== "active" || registered.status !== "active"
      || registered.kind !== "task" || registered.taskId === null
      || registered.employeeId === null) {
      throw new Error("submission run, company, task, or workspace is not active and matched");
    }
    const task = this.#store.getTask(this.#companyId, registered.taskId);
    if (task === null || task.ownerEmployeeId !== registered.employeeId
      || (task.status !== "running" && task.status !== "review")) {
      throw new Error("submission task owner or status is not authoritative");
    }
    assertIdentifier(run.runId, "run id");
    assertIdentifier(registered.taskId, "task id");
    assertWorkspaceIdentifier(registered.workspaceId, "workspace id");
    const company = companyDefinition(this.#store, this.#companyId);
    await assertSafeDirectory(run.projectRoot, registered.path);

    const metadataRunner = new GitCommandRunner({
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 64 * 1024
    });
    const patchRunner = new GitCommandRunner({
      maxStdoutBytes: company.evidence.diffHardLimitBytes + 4,
      maxStderrBytes: 64 * 1024
    });
    const git = async (args: readonly string[]) =>
      await metadataRunner.run(args, { cwd: registered.path });

    const statusResult = await git([
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=all"
    ]);
    if (statusResult.stdout.split(/\r?\n/u).some((line) =>
      line.length > 0 && !line.startsWith("# "))) {
      throw new Error("submission workspace must be clean (index, worktree, and untracked files)");
    }
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-apply",
      "rebase-merge"
    ]) {
      const markerPath = (await git(["rev-parse", "--git-path", marker])).stdout.trim();
      const absoluteMarker = isAbsolute(markerPath)
        ? resolve(markerPath)
        : resolve(registered.path, markerPath);
      if (await pathExists(absoluteMarker)) {
        throw new Error(`submission workspace has an in-progress Git operation: ${marker}`);
      }
    }

    const branchRef = (await git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
    const actualHead = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const registeredRefHead = (await git([
      "rev-parse",
      "--verify",
      `${registered.branchRef}^{commit}`
    ])).stdout.trim();
    if (branchRef !== registered.branchRef || actualHead !== submission.headCommit
      || registeredRefHead !== submission.headCommit
      || registered.headCommit !== submission.headCommit) {
      throw new Error("submission branch or head does not match registered task facts");
    }
    if (registered.baseCommit !== run.integrationCommit) {
      throw new Error("submission base does not match the registered run integration commit");
    }
    const ancestor = await metadataRunner.run([
      "merge-base",
      "--is-ancestor",
      registered.baseCommit,
      submission.headCommit
    ], { cwd: registered.path, allowedExitCodes: [0, 1] });
    if (ancestor.exitCode !== 0) throw new Error("submission head is not descended from task base");
    const refAncestor = await metadataRunner.run([
      "merge-base",
      "--is-ancestor",
      submission.headCommit,
      registered.branchRef
    ], { cwd: registered.path, allowedExitCodes: [0, 1] });
    if (refAncestor.exitCode !== 0) throw new Error("submission head is not reachable from task ref");

    const commits = (await git([
      "rev-list",
      "--reverse",
      "--topo-order",
      `${registered.baseCommit}..${submission.headCommit}`
    ])).stdout.split(/\r?\n/u).filter(Boolean);
    if (commits.length === 0) throw new Error("submission commit range must be non-empty");
    if (commits.length > MAX_COMMITS) throw new Error("submission commit range is too large");
    if (commits.length !== submission.commits.length
      || commits.some((commit, index) => submission.commits[index] !== commit)) {
      throw new Error("declared commits do not exactly match the continuous Git commit range");
    }

    const canonicalCommits: CanonicalCommit[] = [];
    for (const commit of commits) {
      const output = (await git([
        "show",
        "-s",
        "--no-show-signature",
        "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b",
        commit
      ])).stdout;
      const fields = output.replace(/\r?\n$/u, "").split("\0");
      if (fields.length !== 10 || fields[0] !== commit) {
        throw new Error("Git returned malformed canonical commit metadata");
      }
      canonicalCommits.push({
        id: commit,
        parents: fields[1]!.length === 0 ? [] : fields[1]!.split(" "),
        authorName: assertBoundedField(fields[2]!, "commit author name"),
        authorEmail: assertBoundedField(fields[3]!, "commit author email"),
        authoredAt: fields[4]!,
        committerName: assertBoundedField(fields[5]!, "commit committer name"),
        committerEmail: assertBoundedField(fields[6]!, "commit committer email"),
        committedAt: fields[7]!,
        subject: assertBoundedField(fields[8]!, "commit subject"),
        body: assertBoundedField(fields[9]!, "commit body")
      });
    }

    const rawChanges = parseRawChanges((await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--raw",
      "-z",
      "--find-renames",
      "--no-abbrev",
      registered.baseCommit,
      submission.headCommit
    ])).stdout);
    const numstat = parseNumstat((await git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "-z",
      "--find-renames",
      registered.baseCommit,
      submission.headCommit
    ])).stdout);
    if (rawChanges.some(({ oldMode, newMode }) =>
      oldMode === "160000" || newMode === "160000")) {
      throw new Error("submission contains a gitlink or submodule change");
    }
    const files: EvidenceFile[] = [];
    for (const change of rawChanges) {
      const statistics = numstat.get(change.path);
      if (statistics === undefined) throw new Error(`missing numstat metadata: ${change.path}`);
      const objectId = change.code === "D" ? change.oldObject : change.newObject;
      const blob = await hashBlob(
        registered.path,
        objectId,
        company.evidence.diffHardLimitBytes
      );
      files.push({
        path: change.path,
        oldPath: change.oldPath,
        status: status(change.code),
        oldMode: change.oldMode,
        newMode: change.newMode,
        size: blob.size,
        sha256: blob.sha256,
        binary: statistics.added === "-" && statistics.deleted === "-"
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path, "en"));

    const patch = (await patchRunner.run([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      registered.baseCommit,
      submission.headCommit
    ], { cwd: registered.path })).stdout.replaceAll("\r\n", "\n");
    if (patch.includes("GIT binary patch")) {
      throw new Error("binary bytes cannot be embedded in the evidence patch");
    }
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchBytes > company.evidence.diffHardLimitBytes) {
      throw new Error(`submission patch exceeds hard limit: ${patchBytes}`);
    }
    const warnings: SubmissionWarning[] = patchBytes > company.evidence.diffWarningBytes
      ? [{
          code: "patch_warning_limit_exceeded",
          actualBytes: patchBytes,
          warningBytes: company.evidence.diffWarningBytes
        }]
      : [];
    const validations = await this.#authoritativeValidations(
      run.projectRoot,
      registered as GitWorkspaceRecord & { taskId: string },
      submission,
      company
    );
    return {
      schemaVersion: 1,
      submission: structuredClone(submission),
      runId: run.runId,
      taskId: registered.taskId,
      workspaceId: registered.workspaceId,
      employeeId: registered.employeeId,
      branchRef: registered.branchRef,
      baseCommit: registered.baseCommit,
      headCommit: submission.headCommit,
      commits: canonicalCommits,
      files,
      patch,
      patchBytes,
      warnings,
      changeSummary: submission.changeSummary,
      knownRisks: [...submission.knownRisks],
      reportedResults: submission.reportedResults.map((result) => ({ ...result })),
      validations
    };
  }

  async #authoritativeValidations(
    projectRoot: string,
    workspace: GitWorkspaceRecord & { taskId: string },
    submission: GitTaskSubmission,
    company: CompanyDefinition
  ): Promise<AuthoritativeValidation[]> {
    if (new Set(submission.validationCommandIds).size !== submission.validationCommandIds.length) {
      throw new Error("validation command ids must be unique");
    }
    const records = this.#store.listValidationRuns(workspace.runId, workspace.taskId);
    const grants = this.#store.listValidationCommandGrants(workspace.runId, workspace.taskId);
    const expectedDirectory = resolve(
      projectRoot,
      ".agenttown",
      "runs",
      workspace.runId,
      "validation"
    );
    const results: AuthoritativeValidation[] = [];
    for (const commandId of submission.validationCommandIds) {
      assertIdentifier(commandId, "validation command id");
      const configured = company.validation.commands.find(({ id }) => id === commandId);
      const approved = grants.find((grant) =>
        grant.workspaceId === workspace.workspaceId
        && grant.status === "approved"
        && grant.command.id === commandId)?.command;
      const command = configured ?? approved;
      if (command === undefined) {
        throw new Error(`validation command is not configured or approved: ${commandId}`);
      }
      const matches = records.filter((record) =>
        record.runId === workspace.runId
        && record.taskId === workspace.taskId
        && record.workspaceId === workspace.workspaceId
        && record.outcome === "passed"
        && sameCommand(record.command, command)
      ).sort((left, right) =>
        right.completedAt.localeCompare(left.completedAt)
        || right.validationId.localeCompare(left.validationId));
      const record = matches[0];
      if (record === undefined) {
        throw new Error(`authoritative passed validation is missing: ${commandId}`);
      }
      const logPath = resolve(record.logPath);
      if (!isWithin(expectedDirectory, logPath)
        || pathKey(resolve(logPath, "..")) !== pathKey(expectedDirectory)) {
        throw new Error(`validation log path escaped its evidence directory: ${commandId}`);
      }
      const directoryIdentity = await assertSafeDirectory(projectRoot, expectedDirectory);
      const metadata = await lstat(logPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.size > MAX_VALIDATION_LOG_BYTES) {
        throw new Error(`validation log is unsafe or too large: ${commandId}`);
      }
      const log = await readFile(logPath);
      if (!sameDirectory(
        directoryIdentity,
        await assertSafeDirectory(projectRoot, expectedDirectory)
      )) {
        throw new Error(`validation log directory identity changed: ${commandId}`);
      }
      const hash = createHash("sha256").update(log).digest("hex");
      if (hash !== record.logHash) {
        throw new Error(`validation log hash is tampered: ${commandId}`);
      }
      results.push({ record, log });
    }
    return results;
  }
}
