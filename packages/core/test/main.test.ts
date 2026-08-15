import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCompanyYaml } from "@agenttown/runtime-contract";
import {
  assertCorePathWithinProject,
  createShutdownCoordinator,
  parseE2EStartupScenarios,
  parseCoreArguments,
  runCore,
  validateCoreStateLayout
} from "../src/main.js";

const fakeCompany = `schema_version: 1
company:
  name: race-test
  mission: test
  success_criteria: [safe]
  operating_rules: [safe]
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: read_only
limits:
  max_task_retry: 1
  max_review_loops: 1
  max_parallel_tasks: 1
`;

const codexLeadCompany = `schema_version: 1
company:
  name: codex-lead
  mission: test
  success_criteria: [safe]
  operating_rules: [safe]
employees:
  - id: leader
    role: product_lead
    agent: codex
    reports_to: owner
    workspace: read_only
  - id: developer-a
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: developer-b
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: review_package
limits:
  max_task_retry: 1
  max_review_loops: 1
  max_parallel_tasks: 1
`;

const claudeLeadCompany = `schema_version: 1
company:
  name: claude-lead
  mission: test
  success_criteria: [safe]
  operating_rules: [safe]
employees:
  - id: leader
    role: product_lead
    agent: claude
    reports_to: owner
    workspace: read_only
  - id: reviewer
    role: reviewer
    agent: fake
    reports_to: leader
    workspace: read_only
limits:
  max_task_retry: 1
  max_review_loops: 1
  max_parallel_tasks: 1
`;

async function prepareCompanyProject(yaml: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "agenttown-company-"));
  const stateDir = join(project, ".agenttown");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "company.yaml"), yaml);
  return project;
}

const companyRunArgs = (project: string): readonly string[] => [
  "--project-root", project,
  "--database", join(project, ".agenttown", "agenttown.sqlite"),
  "--company", join(project, ".agenttown", "company.yaml"),
  "--pipe-name", "agenttown-0123456789abcdef01234567",
  "--lease-ttl-ms", "15000"
];

describe("Core-owned startup scenarios", () => {
  const company = parseCompanyYaml(fakeCompany);

  it("accepts roster-validated overrides only through the fake-only E2E seam", () => {
    expect(parseE2EStartupScenarios(company, {
      AGENTTOWN_E2E_MODE: "1",
      AGENTTOWN_FORBID_REAL_PROBES: "1",
      AGENTTOWN_E2E_STARTUP_SCENARIOS: JSON.stringify({
        leader: "silent"
      })
    })).toEqual({ leader: "silent" });

    expect(() => parseE2EStartupScenarios(company, {
      AGENTTOWN_E2E_STARTUP_SCENARIOS: JSON.stringify({
        leader: "silent"
      })
    })).toThrow("E2E mode");
    expect(() => parseE2EStartupScenarios(company, {
      AGENTTOWN_E2E_MODE: "1",
      AGENTTOWN_FORBID_REAL_PROBES: "1",
      AGENTTOWN_E2E_STARTUP_SCENARIOS: JSON.stringify({
        invented: "silent"
      })
    })).toThrow("unknown employee");
  });
});

describe("Core entrypoint arguments", () => {
  const valid = [
    "--project-root", "C:\\work\\project",
    "--database", "C:\\work\\project\\.agenttown\\agenttown.sqlite",
    "--company", "C:\\work\\project\\.agenttown\\company.yaml",
    "--pipe-name", "agenttown-0123456789abcdef01234567",
    "--lease-ttl-ms", "15000"
  ] as const;

  it("parses validated absolute paths and process settings", () => {
    expect(parseCoreArguments(valid)).toEqual({
      projectRoot: "C:\\work\\project",
      databasePath: "C:\\work\\project\\.agenttown\\agenttown.sqlite",
      companyPath: "C:\\work\\project\\.agenttown\\company.yaml",
      pipeName: "agenttown-0123456789abcdef01234567",
      leaseTtlMs: 15_000
    });
  });

  it("rejects path escape, relative roots, invalid pipes and invalid TTL before opening DB", () => {
    expect(() => assertCorePathWithinProject(
      "C:\\work\\project",
      "D:\\agenttown.sqlite",
      "--database"
    )).toThrow("outside project");
    expect(() => parseCoreArguments([
      ...valid.slice(0, 1),
      "relative",
      ...valid.slice(2)
    ])).toThrow("absolute");
    expect(() => parseCoreArguments([
      ...valid.slice(0, 7),
      "unsafe pipe",
      ...valid.slice(8)
    ])).toThrow("pipe");
    expect(() => parseCoreArguments([
      ...valid.slice(0, 9),
      "0"
    ])).toThrow("positive integer");
    expect(() => parseCoreArguments([
      "--project-root", "C:\\work\\project",
      "--database", "C:\\work\\project\\source.sqlite",
      "--company", "C:\\work\\project\\.agenttown\\company.yaml",
      "--pipe-name", "agenttown-0123456789abcdef01234567",
      "--lease-ttl-ms", "15000"
    ])).toThrow(".agenttown");
  });

  it("rejects a junction or symlinked .agenttown before opening SQLite", async () => {
    const project = await mkdtemp(join(tmpdir(), "agenttown-path-project-"));
    const outside = await mkdtemp(join(tmpdir(), "agenttown-path-outside-"));
    const stateDir = join(project, ".agenttown");
    await mkdir(outside, { recursive: true });
    try {
      try {
        await symlink(outside, stateDir, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if (
          error instanceof Error
          && "code" in error
          && (error as NodeJS.ErrnoException).code === "EPERM"
        ) {
          return;
        }
        throw error;
      }
      await expect(validateCoreStateLayout({
        projectRoot: project,
        databasePath: join(stateDir, "agenttown.sqlite"),
        companyPath: join(stateDir, "company.yaml"),
        pipeName: "agenttown-0123456789abcdef01234567",
        leaseTtlMs: 15_000
      })).rejects.toThrow(/symbolic|junction/u);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects an existing database symlink before SQLite can follow it", async () => {
    const project = await mkdtemp(join(tmpdir(), "agenttown-db-link-project-"));
    const outside = await mkdtemp(join(tmpdir(), "agenttown-db-link-outside-"));
    const stateDir = join(project, ".agenttown");
    const outsideDatabase = join(outside, "outside.sqlite");
    await mkdir(stateDir, { recursive: true });
    await writeFile(outsideDatabase, "");
    try {
      try {
        await symlink(outsideDatabase, join(stateDir, "agenttown.sqlite"), "file");
      } catch (error) {
        if (
          error instanceof Error
          && "code" in error
          && (error as NodeJS.ErrnoException).code === "EPERM"
        ) {
          return;
        }
        throw error;
      }
      await expect(validateCoreStateLayout({
        projectRoot: project,
        databasePath: join(stateDir, "agenttown.sqlite"),
        companyPath: join(stateDir, "company.yaml"),
        pipeName: "agenttown-0123456789abcdef01234567",
        leaseTtlMs: 15_000
      })).rejects.toThrow(/symbolic|junction/u);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("revalidates after an injected pre-open state swap and never writes outside", async () => {
    const project = await mkdtemp(join(tmpdir(), "agenttown-core-race-project-"));
    const outside = await mkdtemp(join(tmpdir(), "agenttown-core-race-outside-"));
    const stateDir = join(project, ".agenttown");
    const backup = join(project, ".agenttown-original");
    await mkdir(stateDir);
    await writeFile(join(stateDir, "company.yaml"), fakeCompany);
    await writeFile(join(outside, "company.yaml"), fakeCompany);
    await writeFile(join(outside, "sentinel"), "unchanged");
    try {
      await expect(runCore([
        "--project-root", project,
        "--database", join(stateDir, "agenttown.sqlite"),
        "--company", join(stateDir, "company.yaml"),
        "--pipe-name", "agenttown-0123456789abcdef01234567",
        "--lease-ttl-ms", "15000"
      ], {
        async beforeStoreOpen() {
          await rename(stateDir, backup);
          await symlink(
            outside,
            stateDir,
            process.platform === "win32" ? "junction" : "dir"
          );
        }
      })).rejects.toThrow(/symbolic|junction/u);
      await expect(readFile(join(outside, "sentinel"), "utf8"))
        .resolves.toBe("unchanged");
      await expect(readFile(join(outside, "agenttown.sqlite"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) {
      if (
        error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return;
      }
      throw error;
    } finally {
      await rm(stateDir, { force: true });
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("hard-exits without awaiting lifecycle cleanup when first-signal budget expires", async () => {
    vi.useFakeTimers();
    const exits: number[] = [];
    let hardCloseCalls = 0;
    const shutdown = createShutdownCoordinator({
      timeoutMs: 100,
      pause: async () => await new Promise<never>(() => undefined),
      closeGracefully: async () => await new Promise<never>(() => undefined),
      closeTransportNow: () => {
        hardCloseCalls += 1;
      },
      closeStore: () => undefined,
      exit: (code) => {
        exits.push(code);
      },
      reportError: () => undefined
    });

    shutdown.handleSignal("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);

    expect(hardCloseCalls).toBe(1);
    expect(exits).toEqual([1]);
    vi.useRealTimers();
  });

  it("exits 130 immediately on a second shutdown signal", () => {
    const exits: number[] = [];
    const shutdown = createShutdownCoordinator({
      timeoutMs: 100,
      pause: async () => await new Promise<never>(() => undefined),
      closeGracefully: async () => undefined,
      closeTransportNow: () => undefined,
      closeStore: () => undefined,
      exit: (code) => {
        exits.push(code);
      },
      reportError: () => undefined
    });

    shutdown.handleSignal("SIGINT");
    shutdown.handleSignal("SIGINT");

    expect(exits).toEqual([130]);
  });
});

describe("agent adapter gate", () => {
  const codexCompany = parseCompanyYaml(codexLeadCompany);

  it("accepts a company with a codex employee outside E2E mode", async () => {
    const project = await prepareCompanyProject(codexLeadCompany);
    try {
      await expect(runCore(companyRunArgs(project), {
        async beforeStoreOpen() {
          throw new Error("codex company passed the adapter gate");
        }
      })).rejects.toThrow("codex company passed the adapter gate");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("still rejects employees of unsupported agents before store open", async () => {
    const project = await prepareCompanyProject(claudeLeadCompany);
    try {
      await expect(runCore(companyRunArgs(project), {
        async beforeStoreOpen() {
          throw new Error("unsupported agent must not reach store open");
        }
      })).rejects.toThrow("unsupported agent adapter: claude");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses codex employees through the fake-only E2E seam", () => {
    expect(() => parseE2EStartupScenarios(codexCompany, {
      AGENTTOWN_E2E_MODE: "1",
      AGENTTOWN_FORBID_REAL_PROBES: "1",
      AGENTTOWN_E2E_STARTUP_SCENARIOS: JSON.stringify({
        leader: "silent"
      })
    })).toThrow("all-fake company");
  });
});
