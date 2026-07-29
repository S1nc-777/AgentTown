import {
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitCommandError,
  GitCommandRunner,
  GitCommandTimeoutError,
  GitOutputOverflowError
} from "../src/git/git-command.js";
import { RepositoryPreflight } from "../src/git/repository-preflight.js";
import {
  createGitFixture,
  detachedRepo,
  dirtyStagedRepo,
  dirtyTrackedRepo,
  dirtyUntrackedRepo,
  ignoredFileRepo,
  linkedWorktreeRepo,
  repositoryWithMarker,
  type GitFixture
} from "./helpers/git-fixture.js";

const fixtures: GitFixture[] = [];
const temporaryPaths: string[] = [];

function tracked<T extends GitFixture>(repo: T): T {
  fixtures.push(repo);
  return repo;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((repo) => repo.cleanup()));
  await Promise.all(temporaryPaths.splice(0).map(
    (path) => rm(path, { force: true, recursive: true })
  ));
});

describe("RepositoryPreflight", () => {
  const preflight = new RepositoryPreflight();

  it("records a clean attached baseline and excludes AgentTown locally", async () => {
    const repo = tracked(await createGitFixture());
    const gitignoreBefore = await readFile(join(repo.root, ".gitignore"), "utf8")
      .catch(() => null);

    const result = await preflight.inspect(repo.root);

    expect(result).toEqual({
      projectRoot: repo.root,
      gitCommonDir: expect.any(String),
      originalBranch: "main",
      baseCommit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      objectIdLength: 40
    });
    expect(await repo.readInfoExclude()).toContain("/.agenttown/");
    expect(await readFile(join(repo.root, ".gitignore"), "utf8").catch(() => null))
      .toBe(gitignoreBefore);
  });

  it("preserves existing exclude content without a final newline and is idempotent", async () => {
    const repo = tracked(await createGitFixture());
    const excludePath = await repo.gitPath("info/exclude");
    await writeFile(excludePath, "existing-rule", "utf8");

    await preflight.inspect(repo.root);
    await preflight.inspect(repo.root);

    expect(await repo.readInfoExclude()).toBe("existing-rule\n/.agenttown/\n");
  });

  it("adds only a final newline when the local exclude rule already exists", async () => {
    const repo = tracked(await createGitFixture());
    const excludePath = await repo.gitPath("info/exclude");
    await writeFile(excludePath, "/.agenttown/", "utf8");

    await preflight.inspect(repo.root);
    await preflight.inspect(repo.root);

    expect(await repo.readInfoExclude()).toBe("/.agenttown/\n");
  });

  it.each([
    ["tracked", dirtyTrackedRepo],
    ["staged", dirtyStagedRepo],
    ["untracked", dirtyUntrackedRepo]
  ])("rejects a %s user worktree", async (_label, arrange) => {
    const repo = tracked(await arrange());
    await expect(preflight.inspect(repo.root)).rejects.toThrow("worktree is not clean");
  });

  it("allows ignored files", async () => {
    const repo = tracked(await ignoredFileRepo());
    await expect(preflight.inspect(repo.root)).resolves.toBeDefined();
  });

  it("allows AgentTown files after adding the local exclude", async () => {
    const repo = tracked(await createGitFixture());
    await repo.write(".agenttown/run.json", "{}\n");
    await expect(preflight.inspect(repo.root)).resolves.toBeDefined();
  });

  it("rejects a project subdirectory instead of silently widening scope", async () => {
    const repo = tracked(await createGitFixture());
    await repo.write("nested/.keep", "");
    await expect(preflight.inspect(join(repo.root, "nested")))
      .rejects.toThrow("repository toplevel");
  });

  it("rejects a bare repository", async () => {
    const repo = tracked(await createGitFixture({ bare: true }));
    await expect(preflight.inspect(repo.root)).rejects.toThrow("bare");
  });

  it("rejects an unborn branch", async () => {
    const repo = tracked(await createGitFixture({ commit: false }));
    await expect(preflight.inspect(repo.root)).rejects.toThrow("at least one commit");
  });

  it("rejects detached HEAD", async () => {
    const repo = tracked(await detachedRepo());
    await expect(preflight.inspect(repo.root)).rejects.toThrow("attached branch");
  });

  it.each([
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG"
  ])("rejects the in-progress Git marker %s", async (marker) => {
    const repo = tracked(await repositoryWithMarker(marker));
    await expect(preflight.inspect(repo.root)).rejects.toThrow("in-progress");
  });

  it("supports linked worktrees and returns their common Git directory", async () => {
    const repo = tracked(await linkedWorktreeRepo());
    const expectedCommonDir = (await repo.git(["rev-parse", "--git-common-dir"]))
      .stdout.trim();

    const result = await preflight.inspect(repo.root);

    expect(result.originalBranch).toBe("linked");
    expect(result.gitCommonDir.replaceAll("\\", "/"))
      .toBe(expectedCommonDir.replaceAll("\\", "/"));
    expect(await repo.readInfoExclude()).toContain("/.agenttown/");
  });
});

describe("GitCommandRunner", () => {
  it("returns allowed nonzero exits and includes safe diagnostics on rejected exits", async () => {
    const repo = tracked(await detachedRepo());
    const runner = new GitCommandRunner();
    const allowed = await runner.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd: repo.root, allowedExitCodes: [0, 1] }
    );
    expect(allowed.exitCode).toBe(1);

    const error = await runner.run(
      ["rev-parse", "--verify", "refs/heads/not-present"],
      { cwd: repo.root }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitCommandError);
    expect(error).toMatchObject({ subcommand: "rev-parse", exitCode: 128 });
    expect((error as Error).message).toContain("fatal:");
    expect((error as Error).message).not.toContain("GIT_TERMINAL_PROMPT");
  });

  it("bounds stdout and stderr independently with typed overflow errors", async () => {
    const repo = tracked(await createGitFixture());
    await repo.write("left.txt", `${"a".repeat(512)}\n`);
    await repo.write("right.txt", `${"b".repeat(512)}\n`);

    const stdoutRunner = new GitCommandRunner({
      maxStdoutBytes: 64,
      maxStderrBytes: 4_096
    });
    const stdoutError = await stdoutRunner.run(
      ["diff", "--no-index", "--", "left.txt", "right.txt"],
      { cwd: repo.root, allowedExitCodes: [0, 1] }
    ).catch((caught: unknown) => caught);
    expect(stdoutError).toBeInstanceOf(GitOutputOverflowError);
    expect(stdoutError).toMatchObject({ stream: "stdout", limitBytes: 64 });

    const stderrRunner = new GitCommandRunner({
      maxStdoutBytes: 4_096,
      maxStderrBytes: 8
    });
    const stderrError = await stderrRunner.run(
      ["not-an-agenttown-command"],
      { cwd: repo.root }
    ).catch((caught: unknown) => caught);
    expect(stderrError).toBeInstanceOf(GitOutputOverflowError);
    expect(stderrError).toMatchObject({ stream: "stderr", limitBytes: 8 });
    expect((stderrError as Error).message).toContain("git:");
  });

  it("times out and verifies cleanup of the Git-owned process tree", async () => {
    const repo = tracked(await createGitFixture());
    const helperRoot = await mkdtemp(join(tmpdir(), "agenttown-git-helper-"));
    temporaryPaths.push(helperRoot);
    const helperPath = join(helperRoot, "credential-helper.mjs");
    const pidsPath = join(helperRoot, "pids.json");
    await writeFile(helperPath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid]));`,
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");
    const portableHelperPath = helperPath.replaceAll("\\", "/").replaceAll("'", "'\\''");
    const runner = new GitCommandRunner();

    const error = await runner.run([
      "-c",
      `alias.agenttown-timeout=!node '${portableHelperPath}'`,
      "agenttown-timeout"
    ], {
      cwd: repo.root,
      timeoutMs: 1_500
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GitCommandTimeoutError);
    const pids = JSON.parse(await readFile(pidsPath, "utf8")) as number[];
    expect(pids).toHaveLength(2);
    expect(pids.every((pid) => !processAlive(pid))).toBe(true);
  }, 10_000);
});
