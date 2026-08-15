import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import type {
  ActionProposal,
  GitTaskSubmission,
  ReviewDecision,
  ReviewTaskContext,
  WritableTaskContext
} from "@agenttown/runtime-contract";

export type GitFixtureScenario =
  | "git-developer-a"
  | "git-developer-b"
  | "git-review-approve"
  | "git-review-reject"
  | "git-conflict"
  | "git-conflict-resolve";

export const GIT_FIXTURE_SCENARIOS: readonly GitFixtureScenario[] = [
  "git-developer-a",
  "git-developer-b",
  "git-review-approve",
  "git-review-reject",
  "git-conflict",
  "git-conflict-resolve"
];

export interface GitFixtureRunInput {
  context: WritableTaskContext | ReviewTaskContext;
  scenario: GitFixtureScenario;
}

export interface GitFixtureRunResult {
  action: ActionProposal;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
/**
 * Fixed deterministic delay before a Git review decision. Parallel developers
 * must both have their submissions validated (base == current integration
 * commit) before the first approval can start integration; this fixed delay
 * guarantees that ordering without depending on process timing.
 */
const GIT_REVIEW_DELAY_MS = 750;
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C"
} as NodeJS.ProcessEnv;

/**
 * Runs `git` with a fixed argument array (never a shell string). Every argument
 * is either a constant or a path/file produced by this module from the Core
 * supplied context. No scenario accepts commands, paths, messages, refs, or
 * shell text from stdin.
 */
async function runGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<GitResult> {
  const child: ChildProcessWithoutNullStreams = spawn("git", [...args], {
    cwd,
    env: GIT_ENV,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  let settled = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < OUTPUT_LIMIT_BYTES) {
      stdout += chunk.slice(0, OUTPUT_LIMIT_BYTES - stdout.length);
    } else {
      overflow = true;
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < OUTPUT_LIMIT_BYTES) {
      stderr += chunk.slice(0, OUTPUT_LIMIT_BYTES - stderr.length);
    } else {
      overflow = true;
    }
  });
  const timer = setTimeout(() => {
    if (!settled && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, GIT_TIMEOUT_MS);
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? -1);
    });
  }).finally(() => {
    settled = true;
  });
  if (overflow) {
    throw new Error(`git ${args[0] ?? "<missing>"} output exceeded the capture limit`);
  }
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(`git ${args[0] ?? "<missing>"} failed (${exitCode}): ${stderr.trim()}`);
  }
  return { stdout, stderr, exitCode };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

/**
 * Walks upward from `target` to the nearest real directory that contains a
 * real `.agenttown` directory. That ancestor is the registered project root.
 * A target that has no such ancestor is not part of any AgentTown project.
 */
async function resolveProjectRoot(target: string): Promise<string> {
  let current = resolve(target);
  while (true) {
    const candidate = resolve(current, ".agenttown");
    const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata !== null && metadata.isDirectory() && !metadata.isSymbolicLink()) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`workspace path is not inside a registered project root: ${target}`);
    }
    current = parent;
  }
}

/**
 * Verifies that every path segment from the project root to `target` is an
 * ordinary directory (or the target itself), contains no symbolic links, and
 * resolves canonically inside the project root.
 */
async function assertNoPathRedirect(projectRoot: string, target: string): Promise<void> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const segments = relative(resolve(projectRoot), resolve(target))
    .split(/[\\/]/u)
    .filter((segment) => segment.length > 0);
  let current = resolve(projectRoot);
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) continue;
    if (metadata.isSymbolicLink()) {
      throw new Error(`workspace path contains a symbolic link: ${segment}`);
    }
    if (!metadata.isDirectory() && index < segments.length - 1) {
      throw new Error(`workspace path contains a non-directory component: ${segment}`);
    }
    const currentReal = await realpath(current);
    if (!isWithin(canonicalProjectRoot, currentReal)) {
      throw new Error("workspace path escapes the registered project root");
    }
  }
}

/**
 * Resolves and verifies a writable Git workspace. The workspace must live
 * beneath `.agenttown/worktrees/<runId>/` of the registered project root and
 * must not contain any path redirect.
 */
async function verifyWorkspaceRoot(context: WritableTaskContext): Promise<string> {
  const workspaceRoot = resolve(context.workspaceRoot);
  const projectRoot = await resolveProjectRoot(workspaceRoot);
  const relativePath = relative(projectRoot, workspaceRoot);
  if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error(`workspace path is outside the registered project root: ${workspaceRoot}`);
  }
  const expectedPrefix = join(".agenttown", "worktrees", context.runId);
  if (relativePath !== expectedPrefix
    && !relativePath.startsWith(`${expectedPrefix}${sep}`)) {
    throw new Error(
      `workspace path is outside the registered run layout: ${workspaceRoot}`
    );
  }
  await assertNoPathRedirect(projectRoot, workspaceRoot);
  return workspaceRoot;
}

/**
 * Resolves and verifies an immutable review package. The manifest must live
 * beneath `.agenttown/runs/<runId>/reviews/` of the registered project root and
 * its SHA-256 must exactly equal the Core recorded hash.
 */
async function verifyReviewPackage(context: ReviewTaskContext): Promise<string> {
  const manifestPath = resolve(context.manifestPath);
  const projectRoot = await resolveProjectRoot(dirname(manifestPath));
  const relativePath = relative(projectRoot, manifestPath);
  if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
    throw new Error(`review package is outside the registered project root: ${manifestPath}`);
  }
  const expectedPrefix = join(".agenttown", "runs", context.runId, "reviews");
  if (relativePath !== expectedPrefix
    && !relativePath.startsWith(`${expectedPrefix}${sep}`)) {
    throw new Error(`review package is outside the registered evidence layout: ${manifestPath}`);
  }
  await assertNoPathRedirect(projectRoot, manifestPath);
  const content = await readFile(manifestPath);
  const actualHash = createHash("sha256").update(content).digest("hex");
  if (actualHash !== context.manifestHash) {
    throw new Error("review package hash mismatch");
  }
  return actualHash;
}

/**
 * Writes a fixed file and commits it only when the workspace changed. When the
 * workspace already contains exactly the same committed file (for example after
 * a restart), the existing HEAD is reused so recovery is idempotent.
 */
async function commitFixedFile(
  workspaceRoot: string,
  filename: string,
  content: string,
  message: string
): Promise<string> {
  await writeFile(join(workspaceRoot, filename), content, "utf8");
  const status = await runGit(workspaceRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    filename
  ]);
  if (status.stdout.trim().length === 0) {
    return (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
  }
  await runGit(workspaceRoot, ["add", "--", filename]);
  await runGit(workspaceRoot, ["commit", "-m", message]);
  return (await runGit(workspaceRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

function submitAction(
  context: WritableTaskContext,
  headCommit: string,
  changeSummary: string
): ActionProposal {
  const submission: GitTaskSubmission = {
    schemaVersion: 1,
    headCommit,
    commits: [headCommit],
    changeSummary,
    validationCommandIds: [...context.approvedValidationCommandIds],
    suggestedValidationCommands: [],
    reportedResults: [],
    knownRisks: []
  };
  return {
    schemaVersion: 1,
    actionId: randomUUID(),
    type: "task.submit",
    actorEmployeeId: context.employeeId,
    taskId: context.taskId,
    payload: { submission },
    reason: "deterministic git fixture completion",
    causationEventId: null
  };
}

function reviewAction(
  context: ReviewTaskContext,
  type: "task.approve" | "task.reject",
  decision: ReviewDecision
): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: randomUUID(),
    type,
    // The process identity (company-cli) overrides the actor before proposing;
    // the ReviewTaskContext deliberately does not carry an employee id.
    actorEmployeeId: "reviewer",
    taskId: context.taskId,
    payload: { revision: context.revision, decision },
    reason: "deterministic git fixture review",
    causationEventId: null
  };
}

async function addIndependentFileA(context: WritableTaskContext): Promise<ActionProposal> {
  const workspaceRoot = await verifyWorkspaceRoot(context);
  const headCommit = await commitFixedFile(
    workspaceRoot,
    "feature-a.txt",
    "feature-a\n",
    "fake: task-a"
  );
  return submitAction(context, headCommit, "fake: add feature-a.txt");
}

async function addIndependentFileB(context: WritableTaskContext): Promise<ActionProposal> {
  const workspaceRoot = await verifyWorkspaceRoot(context);
  const headCommit = await commitFixedFile(
    workspaceRoot,
    "feature-b.txt",
    "feature-b\n",
    "fake: task-b"
  );
  return submitAction(context, headCommit, "fake: add feature-b.txt");
}

async function editSharedLine(context: WritableTaskContext): Promise<ActionProposal> {
  const workspaceRoot = await verifyWorkspaceRoot(context);
  const content = `conflict-${context.employeeId}\n`;
  const headCommit = await commitFixedFile(
    workspaceRoot,
    "shared.txt",
    content,
    "fake: conflict shared"
  );
  return submitAction(context, headCommit, "fake: edit shared line");
}

async function resolveSharedLine(context: WritableTaskContext): Promise<ActionProposal> {
  const workspaceRoot = await verifyWorkspaceRoot(context);
  const headCommit = await commitFixedFile(
    workspaceRoot,
    "shared.txt",
    "resolved\n",
    "fake: resolve shared"
  );
  return submitAction(context, headCommit, "fake: resolve shared line");
}

async function approveManifest(context: ReviewTaskContext): Promise<ActionProposal> {
  const manifestHash = await verifyReviewPackage(context);
  await new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, GIT_REVIEW_DELAY_MS)
  );
  const decision: ReviewDecision = {
    schemaVersion: 1,
    decision: "approve",
    findings: [],
    coverageGaps: [],
    summary: "fake: approved",
    reviewedManifestHash: manifestHash
  };
  return reviewAction(context, "task.approve", decision);
}

async function rejectManifest(context: ReviewTaskContext): Promise<ActionProposal> {
  const manifestHash = await verifyReviewPackage(context);
  await new Promise<void>((resolvePromise) =>
    setTimeout(resolvePromise, GIT_REVIEW_DELAY_MS)
  );
  const decision: ReviewDecision = {
    schemaVersion: 1,
    decision: "reject",
    findings: [{
      severity: "blocking",
      evidence: "fake:review:changes_requested",
      requiredChange: "fake:review:apply_change"
    }],
    coverageGaps: [],
    summary: "fake: rejected",
    reviewedManifestHash: manifestHash
  };
  return reviewAction(context, "task.reject", decision);
}

type GitFixtureHandler =
  | ((context: WritableTaskContext) => Promise<ActionProposal>)
  | ((context: ReviewTaskContext) => Promise<ActionProposal>);

const handlers: Record<GitFixtureScenario, GitFixtureHandler> = {
  "git-developer-a": addIndependentFileA,
  "git-developer-b": addIndependentFileB,
  "git-review-approve": approveManifest,
  "git-review-reject": rejectManifest,
  "git-conflict": editSharedLine,
  "git-conflict-resolve": resolveSharedLine
};

function isReviewScenario(scenario: GitFixtureScenario): boolean {
  return scenario === "git-review-approve" || scenario === "git-review-reject";
}

/**
 * Executes one deterministic Git fixture scenario. The scenario table is closed:
 * each handler writes fixed fixture files with fixed content, calls Git with
 * fixed argument arrays, and returns a structured `task.submit`, `task.approve`,
 * or `task.reject` action. Nothing from stdin influences any file, path, commit
 * message, ref, or Git argument.
 */
export async function runGitFixture(input: GitFixtureRunInput): Promise<GitFixtureRunResult> {
  const handler = handlers[input.scenario];
  if (handler === undefined) {
    throw new Error(`unknown Git fixture scenario: ${String(input.scenario)}`);
  }
  if (isReviewScenario(input.scenario) && input.context.kind !== "review_package") {
    throw new Error("git review scenarios require a review package context");
  }
  if (!isReviewScenario(input.scenario) && input.context.kind !== "git_worktree") {
    throw new Error("git developer scenarios require a writable task context");
  }
  const action = await handler(input.context as never);
  return { action };
}
