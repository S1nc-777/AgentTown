import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve
} from "node:path";
import { randomUUID } from "node:crypto";
import type { GitRunRecord } from "@agenttown/runtime-contract";
import { GitCommandRunner } from "./git-command.js";

const MINIMUM_GIT_VERSION = [2, 31, 0] as const;
const AGENTTOWN_EXCLUDE = "/.agenttown/";
const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
  "BISECT_START"
] as const;

export interface RepositoryBaseline extends Pick<
  GitRunRecord,
  "projectRoot" | "originalBranch" | "baseCommit"
> {
  gitCommonDir: string;
  objectIdLength: 40 | 64;
}

interface GitRunner {
  run: GitCommandRunner["run"];
}

function trimmedLine(output: string, label: string): string {
  const value = output.trim();
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new Error(`Git returned an invalid ${label}`);
  }
  return value;
}

function parseGitVersion(output: string): readonly [number, number, number] {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:[.\s-]|$)/u.exec(output.trim());
  if (match === null) throw new Error("Git returned an unsupported version response");
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  ];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number]
): boolean {
  for (let index = 0; index < minimum.length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === ""
    || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function resolvedGitPath(projectRoot: string, output: string, label: string): string {
  const value = trimmedLine(output, label);
  return resolve(isAbsolute(value) ? value : resolve(projectRoot, value));
}

async function assertSafeMetadataPath(
  gitCommonDir: string,
  target: string
): Promise<void> {
  if (!isWithin(gitCommonDir, target) || target === gitCommonDir) {
    throw new Error("Git metadata path escaped the repository common directory");
  }
  const segments = relative(gitCommonDir, target).split(/[\\/]/u);
  let current = gitCommonDir;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`Git metadata path contains a symbolic link: ${segment}`);
    }
    if (index < segments.length - 1 && !metadata.isDirectory()) {
      throw new Error(`Git metadata parent is not a directory: ${segment}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function appendExclude(existing: string): string | null {
  if (existing.split(/\r?\n/u).includes(AGENTTOWN_EXCLUDE)) {
    return existing.endsWith("\n") ? null : `${existing}\n`;
  }
  if (existing.length === 0) return `${AGENTTOWN_EXCLUDE}\n`;
  return `${existing}${existing.endsWith("\n") ? "" : "\n"}${AGENTTOWN_EXCLUDE}\n`;
}

async function updateExcludeAtomically(path: string): Promise<void> {
  const existing = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  );
  const updated = appendExclude(existing);
  if (updated === null) return;

  await mkdir(dirname(path), { recursive: true });
  const existingMode = await stat(path)
    .then(({ mode }) => mode)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0o600;
      throw error;
    });
  const temporaryPath = resolve(dirname(path), `.agenttown-exclude-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", existingMode);
  let renamed = false;
  try {
    await handle.writeFile(updated, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

function validateWorktreeProtocol(output: string, projectRoot: string): void {
  const entries = output
    .split(/\r?\n\r?\n/u)
    .map((block) => block.split(/\r?\n/u)[0])
    .filter((line): line is string => line?.startsWith("worktree ") === true)
    .map((line) => resolve(line.slice("worktree ".length)));
  if (entries.length === 0) {
    throw new Error("Git worktree porcelain protocol returned no worktrees");
  }
  if (!entries.some((path) => path === projectRoot)) {
    throw new Error("Git worktree porcelain protocol omitted the project root");
  }
}

export class RepositoryPreflight {
  readonly #git: GitRunner;

  constructor(git: GitRunner = new GitCommandRunner()) {
    this.#git = git;
  }

  async inspect(projectRoot: string): Promise<RepositoryBaseline> {
    let canonicalProjectRoot: string;
    try {
      canonicalProjectRoot = await realpath(resolve(projectRoot));
    } catch (error) {
      throw new Error("project root does not exist or cannot be resolved", { cause: error });
    }
    if (!(await stat(canonicalProjectRoot)).isDirectory()) {
      throw new Error("project root must be a directory");
    }

    const versionResult = await this.#git.run(["--version"], {
      cwd: canonicalProjectRoot
    });
    const gitVersion = parseGitVersion(versionResult.stdout);
    if (!versionAtLeast(gitVersion, MINIMUM_GIT_VERSION)) {
      throw new Error("AgentTown requires Git 2.31.0 or newer");
    }

    const toplevelResult = await this.#git.run(
      ["rev-parse", "--show-toplevel"],
      { cwd: canonicalProjectRoot, allowedExitCodes: [0, 128] }
    );
    const bareResult = await this.#git.run(
      ["rev-parse", "--is-bare-repository"],
      { cwd: canonicalProjectRoot, allowedExitCodes: [0, 128] }
    );
    if (bareResult.exitCode === 0 && bareResult.stdout.trim() === "true") {
      throw new Error("project repository must not be bare");
    }
    if (toplevelResult.exitCode !== 0 || bareResult.exitCode !== 0) {
      throw new Error("project root is not a Git repository");
    }
    if (bareResult.stdout.trim() !== "false") {
      throw new Error("Git returned an invalid bare-repository response");
    }
    const canonicalToplevel = await realpath(
      resolvedGitPath(canonicalProjectRoot, toplevelResult.stdout, "repository toplevel")
    );
    if (canonicalToplevel !== canonicalProjectRoot) {
      throw new Error("project root must equal the repository toplevel");
    }

    const branchResult = await this.#git.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: canonicalProjectRoot, allowedExitCodes: [0, 1, 128] }
    );
    if (branchResult.exitCode !== 0) {
      throw new Error("project repository must have an attached branch");
    }
    const originalBranch = trimmedLine(branchResult.stdout, "branch name");

    const headResult = await this.#git.run(
      ["rev-parse", "HEAD"],
      { cwd: canonicalProjectRoot, allowedExitCodes: [0, 128] }
    );
    if (headResult.exitCode !== 0) {
      throw new Error("project repository must have at least one commit");
    }
    const baseCommit = trimmedLine(headResult.stdout, "HEAD object ID");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseCommit)) {
      throw new Error("Git returned an invalid HEAD object ID");
    }

    const commonDirResult = await this.#git.run(
      ["rev-parse", "--git-common-dir"],
      { cwd: canonicalProjectRoot }
    );
    const gitCommonDir = await realpath(resolvedGitPath(
      canonicalProjectRoot,
      commonDirResult.stdout,
      "Git common directory"
    ));
    if (!(await stat(gitCommonDir)).isDirectory()) {
      throw new Error("Git common directory is not a directory");
    }

    for (const marker of IN_PROGRESS_MARKERS) {
      const markerResult = await this.#git.run(
        ["rev-parse", "--git-path", marker],
        { cwd: canonicalProjectRoot }
      );
      const markerPath = resolvedGitPath(
        canonicalProjectRoot,
        markerResult.stdout,
        `Git ${marker} path`
      );
      await assertSafeMetadataPath(gitCommonDir, markerPath);
      if (await pathExists(markerPath)) {
        throw new Error(`project repository has an in-progress Git operation (${marker})`);
      }
    }

    const excludeResult = await this.#git.run(
      ["rev-parse", "--git-path", "info/exclude"],
      { cwd: canonicalProjectRoot }
    );
    const excludePath = resolvedGitPath(
      canonicalProjectRoot,
      excludeResult.stdout,
      "Git exclude path"
    );
    await assertSafeMetadataPath(gitCommonDir, excludePath);
    await updateExcludeAtomically(excludePath);

    const statusResult = await this.#git.run(
      ["status", "--porcelain=v2", "--untracked-files=normal"],
      { cwd: canonicalProjectRoot }
    );
    if (statusResult.stdout.split(/\r?\n/u).some((line) => line.length > 0)) {
      throw new Error("project worktree is not clean");
    }

    const worktreeResult = await this.#git.run(
      ["worktree", "list", "--porcelain"],
      { cwd: canonicalProjectRoot }
    );
    validateWorktreeProtocol(worktreeResult.stdout, canonicalProjectRoot);

    const updateRefResult = await this.#git.run(
      ["update-ref", "--stdin"],
      { cwd: canonicalProjectRoot, stdin: "" }
    );
    if (updateRefResult.stdout.length !== 0 || updateRefResult.stderr.length !== 0) {
      throw new Error("Git update-ref protocol returned unexpected output");
    }

    return {
      projectRoot: canonicalProjectRoot,
      gitCommonDir,
      originalBranch,
      baseCommit,
      objectIdLength: baseCommit.length as 40 | 64
    };
  }
}
