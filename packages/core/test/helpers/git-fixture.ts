import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface GitFixtureOptions {
  bare?: boolean;
  commit?: boolean;
}

interface TestGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitFixture {
  root: string;
  cleanup(): Promise<void>;
  git(args: readonly string[], allowedExitCodes?: readonly number[]): Promise<TestGitResult>;
  gitPath(marker: string): Promise<string>;
  readInfoExclude(): Promise<string>;
  write(relativePath: string, content: string): Promise<void>;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0]
): Promise<TestGitResult> {
  const child = spawn("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C"
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? -1));
  });
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(`git ${args[0] ?? "<missing>"} failed (${exitCode}): ${stderr}`);
  }
  return { stdout, stderr, exitCode };
}

function fixture(
  container: string,
  root: string
): GitFixture {
  return {
    root,
    cleanup: () => rm(container, { force: true, recursive: true }),
    git: (args, allowedExitCodes) => runGit(root, args, allowedExitCodes),
    async gitPath(marker) {
      const { stdout } = await runGit(root, ["rev-parse", "--git-path", marker]);
      const path = stdout.trim();
      return isAbsolute(path) ? resolve(path) : resolve(root, path);
    },
    async readInfoExclude() {
      const path = await this.gitPath("info/exclude");
      return readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    },
    async write(relativePath, content) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
  };
}

export async function createGitFixture(
  options: GitFixtureOptions = {}
): Promise<GitFixture> {
  const container = await mkdtemp(join(tmpdir(), "agenttown-git-"));
  const root = options.bare === true ? join(container, "repo.git") : join(container, "repo");
  await mkdir(root, { recursive: true });
  await runGit(root, options.bare === true
    ? ["init", "--bare"]
    : ["init", "-b", "main"]);
  const repo = fixture(container, root);
  if (options.bare !== true) {
    await repo.git(["config", "user.name", "AgentTown Test"]);
    await repo.git(["config", "user.email", "agenttown@example.invalid"]);
    if (options.commit !== false) {
      await repo.write("README.md", "initial\n");
      await repo.git(["add", "README.md"]);
      await repo.git(["commit", "-m", "initial"]);
    }
  }
  return repo;
}

export async function dirtyTrackedRepo(): Promise<GitFixture> {
  const repo = await createGitFixture();
  await repo.write("README.md", "tracked change\n");
  return repo;
}

export async function dirtyStagedRepo(): Promise<GitFixture> {
  const repo = await createGitFixture();
  await repo.write("staged.txt", "staged\n");
  await repo.git(["add", "staged.txt"]);
  return repo;
}

export async function dirtyUntrackedRepo(): Promise<GitFixture> {
  const repo = await createGitFixture();
  await repo.write("untracked.txt", "untracked\n");
  return repo;
}

export async function ignoredFileRepo(): Promise<GitFixture> {
  const repo = await createGitFixture();
  await repo.write(".gitignore", "ignored.txt\n");
  await repo.git(["add", ".gitignore"]);
  await repo.git(["commit", "-m", "ignore fixture"]);
  await repo.write("ignored.txt", "ignored\n");
  return repo;
}

export async function detachedRepo(): Promise<GitFixture> {
  const repo = await createGitFixture();
  await repo.git(["checkout", "--detach"]);
  return repo;
}

export async function repositoryWithMarker(marker: string): Promise<GitFixture> {
  const repo = await createGitFixture();
  const path = await repo.gitPath(marker);
  if (marker.startsWith("rebase-")) {
    await mkdir(path, { recursive: true });
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "in progress\n", "utf8");
  }
  return repo;
}

export async function linkedWorktreeRepo(): Promise<GitFixture> {
  const primary = await createGitFixture();
  const linkedRoot = join(dirname(primary.root), "linked");
  await primary.git(["worktree", "add", "-b", "linked", linkedRoot]);
  return fixture(dirname(primary.root), linkedRoot);
}
