import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

export interface AgentTownPaths {
  projectRoot: string;
  stateDir: string;
  databasePath: string;
  companyPath: string;
  logsDir: string;
}

export function assertWithinProject(projectRoot: string, candidate: string): string {
  const root = resolve(projectRoot);
  const target = resolve(candidate);
  const relativePath = relative(root, target);
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error(`path outside project: ${target}`);
  }
  return target;
}

export function resolveAgentTownPaths(projectRoot: string): AgentTownPaths {
  const root = resolve(projectRoot);
  const stateDir = assertWithinProject(root, join(root, ".agenttown"));
  return {
    projectRoot: root,
    stateDir,
    databasePath: assertWithinProject(root, join(stateDir, "agenttown.sqlite")),
    companyPath: assertWithinProject(root, join(stateDir, "company.yaml")),
    logsDir: assertWithinProject(root, join(stateDir, "logs"))
  };
}

async function optionalLstat(
  path: string
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return childPath === ""
    || (
      childPath !== ".."
      && !childPath.startsWith(`..${sep}`)
      && !isAbsolute(childPath)
    );
}

export async function validateAgentTownWriteLayout(
  paths: AgentTownPaths
): Promise<void> {
  const projectReal = await realpath(paths.projectRoot);
  const stateStat = await optionalLstat(paths.stateDir);
  if (stateStat?.isSymbolicLink() === true) {
    throw new Error(".agenttown must not be a symbolic link or junction");
  }
  if (stateStat === null) return;

  const stateReal = await realpath(paths.stateDir);
  if (!isWithin(projectReal, stateReal)) {
    throw new Error(".agenttown resolves outside project");
  }
  for (const candidate of [
    paths.databasePath,
    paths.companyPath,
    paths.logsDir
  ]) {
    const candidateStat = await optionalLstat(candidate);
    if (candidateStat?.isSymbolicLink() === true) {
      throw new Error(`AgentTown state path is a symbolic link or junction: ${candidate}`);
    }
    if (candidateStat !== null) {
      const candidateReal = await realpath(candidate);
      if (!isWithin(stateReal, candidateReal)) {
        throw new Error(`AgentTown state path resolves outside .agenttown: ${candidate}`);
      }
    }
  }
}

export function pipeNameForProject(
  projectRoot: string,
  identity = { username: userInfo().username, homedir: homedir() }
): string {
  const normalizeIdentity = (value: string): string =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  const digest = createHash("sha256")
    .update([
      normalizeIdentity(identity.username),
      normalizeIdentity(resolve(identity.homedir)),
      normalizeIdentity(resolve(projectRoot))
    ].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `agenttown-${digest}`;
}
