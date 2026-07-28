import { createHash } from "node:crypto";
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
