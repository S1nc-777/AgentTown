import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CompanyDefinition } from "@agenttown/runtime-contract";

export async function createTemporaryProject(): Promise<{
  root: string;
  databasePath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agenttown-core-"));
  const resolvedRoot = resolve(root);

  return {
    root: resolvedRoot,
    databasePath: join(resolvedRoot, "core.sqlite"),
    cleanup: async () => {
      const resolvedTarget = resolve(resolvedRoot);
      if (resolvedTarget !== resolvedRoot || !resolvedTarget.startsWith(resolve(tmpdir()))) {
        throw new Error(`refusing to remove unbounded temporary path: ${resolvedTarget}`);
      }
      await rm(resolvedTarget, { recursive: true, force: true });
    }
  };
}

export function companyDefinitionFixture(): CompanyDefinition {
  return {
    schemaVersion: 1,
    company: {
      name: "Fixture Company",
      mission: "Test AgentTown core storage",
      successCriteria: ["Storage behavior is deterministic"],
      operatingRules: ["Persist facts and events atomically"]
    },
    employees: [
      {
        id: "leader",
        role: "Leader",
        agent: "fake",
        reportsTo: "owner",
        workspace: "read_only"
      },
      {
        id: "developer",
        role: "Developer",
        agent: "fake",
        reportsTo: "leader",
        workspace: "git_worktree"
      },
      {
        id: "reviewer",
        role: "Reviewer",
        agent: "fake",
        reportsTo: "leader",
        workspace: "review_package"
      }
    ],
    limits: {
      maxTaskRetry: 1,
      maxReviewLoops: 2,
      maxParallelTasks: 2
    },
    validation: {
      commands: [],
      integrationCommandIds: []
    },
    evidence: {
      diffWarningBytes: 2 * 1024 * 1024,
      diffHardLimitBytes: 20 * 1024 * 1024
    }
  };
}
