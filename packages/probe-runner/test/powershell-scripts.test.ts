import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const scriptsRoot = join(repositoryRoot, "scripts");
const artifactRoot = join(repositoryRoot, "artifacts", "feasibility");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe.runIf(process.platform === "win32")("PowerShell benchmark entry points", () => {
  it("wires real, framework, fake, and score entry points only after their files exist", async () => {
    const rootPackage = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const runnerPackage = JSON.parse(await readFile(join(repositoryRoot, "packages", "probe-runner", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(rootPackage.scripts["probe:real"]).toBe("powershell -NoProfile -File scripts/run-real-probes.ps1");
    expect(rootPackage.scripts["benchmark:frameworks"]).toBe("powershell -NoProfile -File scripts/run-framework-benchmark.ps1");
    expect(runnerPackage.scripts["score-frameworks"]).toBe("tsx src/score-frameworks.ts");
    expect(runnerPackage.scripts["probe:fake"]).toContain("benchmark.test.ts");
  }, 20_000);

  it("keeps real-agent gates child-scoped and removes only a verified temp Git directory", async () => {
    const source = await readFile(join(scriptsRoot, "run-real-probes.ps1"), "utf8");
    expect(source).toContain("Get-Command");
    expect(source).toContain("AGENTTOWN_REAL_CODEX");
    expect(source).toContain("AGENTTOWN_REAL_CLAUDE");
    expect(source).toContain("AGENTTOWN_REAL_TIMEOUT_MS");
    expect(source).toContain("CapabilitiesOnly");
    expect(source).toContain("bounded-process.ps1");
    expect(source).not.toContain("FixtureChildAction");
    expect(source).not.toContain("ValidationChildMode");
    const boundedSource = await readFile(join(scriptsRoot, "lib", "bounded-process.ps1"), "utf8");
    expect(boundedSource).toContain("Start-Process");
    expect(boundedSource).toContain("StartTime");
    expect(boundedSource).toContain("WaitForExit");
    expect(boundedSource).toContain("taskkill.exe");
    expect(source).toContain("[System.IO.Path]::GetTempPath()");
    expect(source).toContain('@("init", "--quiet"');
    expect(source).not.toMatch(/Remove-Item\s+\$env:/iu);

    const parent = await temporaryDirectory("agenttown-real-script-test-");
    const summaryPath = join(parent, "summary.json");
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-real-probes.ps1"),
      "-ValidateOnly", "-TempParent", parent, "-SummaryPath", summaryPath
    ], {
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTTOWN_REAL_CODEX: "0",
        AGENTTOWN_REAL_CLAUDE: "0",
        AGENTTOWN_FORBID_REAL_PROBES: "1"
      }
    });

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { validation: { tempCleanupVerified: boolean } };
    expect(summary.validation.tempCleanupVerified).toBe(true);
    expect((await readdir(parent)).sort()).toEqual(["summary.json"]);
  }, 20_000);

  it("summarizes every real lifecycle step with exact blockers without launching agents", async () => {
    const parent = await temporaryDirectory("agenttown-real-summary-test-");
    const summaryPath = join(parent, "summary.json");
    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-real-probes.ps1"),
      "-SummarizeOnly", "-ArtifactRoot", artifactRoot,
      "-TempParent", parent, "-SummaryPath", summaryPath
    ], {
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTTOWN_REAL_CODEX: "0",
        AGENTTOWN_REAL_CLAUDE: "0",
        AGENTTOWN_FORBID_REAL_PROBES: "1"
      }
    }).catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      agents: Array<{
        agent: string;
        steps: { firstTurn: boolean; resume: boolean; interrupt: boolean; parallelThree: boolean };
        blockers: string[];
      }>;
    };
    expect(summary.agents).toEqual([
      expect.objectContaining({
        agent: "codex",
        steps: { firstTurn: false, resume: false, interrupt: false, parallelThree: false },
        blockers: expect.arrayContaining([
          "launch_failed", "interrupt_not_verified", "parallel_three_not_verified"
        ])
      }),
      expect.objectContaining({
        agent: "claude",
        steps: { firstTurn: true, resume: true, interrupt: false, parallelThree: false },
        blockers: expect.arrayContaining([
          "interrupt_session_not_observed",
          "parallel_partial_failure:one:exit_1",
          "parallel_partial_failure:two:exit_1",
          "parallel_partial_failure:three:exit_1",
          "interrupt_not_verified",
          "parallel_three_not_verified"
        ])
      })
    ]);
    expect((await readdir(parent)).sort()).toEqual(["summary.json"]);
  }, 20_000);

  it("refuses the real branch when the offline-test guard is set", async () => {
    const parent = await temporaryDirectory("agenttown-real-guard-test-");
    const codexBefore = await readFile(join(artifactRoot, "codex-real", "report.json"), "utf8");
    const claudeBefore = await readFile(join(artifactRoot, "claude-real", "report.json"), "utf8");
    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-real-probes.ps1"),
      "-CapabilitiesOnly", "-TempParent", parent, "-SummaryPath", join(parent, "summary.json")
    ], {
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTTOWN_REAL_CODEX: "0",
        AGENTTOWN_REAL_CLAUDE: "0",
        AGENTTOWN_FORBID_REAL_PROBES: "1"
      }
    }).catch((error: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => error);

    expect(failure.code).not.toBe(0);
    expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).toContain("real_probe_execution_disabled");
    const summary = JSON.parse(await readFile(join(parent, "summary.json"), "utf8")) as {
      observedExitKind: string;
      executionBlockers: string[];
    };
    expect(summary.observedExitKind).toBe("forbidden");
    expect(summary.executionBlockers).toEqual(["real_probe_execution_disabled"]);
    expect(await readFile(join(artifactRoot, "codex-real", "report.json"), "utf8")).toBe(codexBefore);
    expect(await readFile(join(artifactRoot, "claude-real", "report.json"), "utf8")).toBe(claudeBefore);
    expect(await readdir(parent)).toEqual(["summary.json"]);
  }, 20_000);

  it.each([
    { scenario: "taskkill-nonzero", blocker: "termination_unverified" },
    { scenario: "process-survives", blocker: "orphan_process" },
    { scenario: "identity-mismatch", blocker: "termination_unverified" },
    { scenario: "identity-query-error", blocker: "termination_unverified" }
  ])("reports $blocker when bounded termination hits $scenario", async ({ scenario, blocker }) => {
    const parent = await temporaryDirectory(`agenttown-termination-${scenario}-test-`);
    const summaryPath = join(parent, "summary.json");
    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "test-harness", "bounded-process-harness.ps1"),
      "-Scenario", scenario, "-SummaryPath", summaryPath
    ], { timeout: 20_000,
      env: { ...process.env, AGENTTOWN_FORBID_REAL_PROBES: "1" }
    }).catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      blocker: string;
      taskkillCalled: boolean;
    };
    expect(summary.blocker).toBe(blocker);
    expect(summary.taskkillCalled).toBe(!["identity-mismatch", "identity-query-error"].includes(scenario));
    expect((await readdir(parent)).sort()).toEqual(["summary.json"]);
  }, 20_000);

  it("writes the framework summary even when a locked log prevents temporary cleanup", async () => {
    const parent = await temporaryDirectory("agenttown-framework-locked-cleanup-test-");
    const summaryPath = join(parent, "summary.json");
    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "test-harness", "framework-cleanup-harness.ps1"),
      "-SummaryPath", summaryPath
    ], { timeout: 20_000, env: { ...process.env, AGENTTOWN_FORBID_REAL_PROBES: "1" } })
      .catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { blockers: string[] };
    expect(summary.blockers).toEqual(["framework_temp_cleanup_unverified"]);
    expect((await readdir(parent)).sort()).toEqual(["summary.json"]);
    const source = await readFile(join(scriptsRoot, "run-framework-benchmark.ps1"), "utf8");
    expect(source).toContain("Remove-FrameworkMeasurementLogs");
  }, 20_000);

  it("turns malformed and missing Agent reports into exact blockers and still writes a summary", async () => {
    const root = await temporaryDirectory("agenttown-malformed-report-test-");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "codex-real"), { recursive: true }));
    await writeFile(join(root, "codex-real", "report.json"), "{ truncated", "utf8");
    const summaryPath = join(root, "summary.json");

    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-real-probes.ps1"),
      "-SummarizeOnly", "-ArtifactRoot", root, "-TempParent", root, "-SummaryPath", summaryPath
    ], {
      timeout: 20_000,
      env: { ...process.env, AGENTTOWN_FORBID_REAL_PROBES: "1", AGENTTOWN_REAL_CODEX: "0", AGENTTOWN_REAL_CLAUDE: "0" }
    }).catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      agents: Array<{ agent: string; blockers: string[] }>;
    };
    expect(summary.agents).toEqual([
      expect.objectContaining({ agent: "codex", blockers: expect.arrayContaining(["report_malformed"]) }),
      expect.objectContaining({ agent: "claude", blockers: expect.arrayContaining(["report_missing"]) })
    ]);
  }, 20_000);

  it("suppresses blocked framework measurements and never mutates source artifacts", async () => {
    const root = await temporaryDirectory("agenttown-framework-script-test-");
    await cp(join(artifactRoot, "framework-electron.json"), join(root, "framework-electron.json"));
    await cp(join(artifactRoot, "framework-tauri.json"), join(root, "framework-tauri.json"));
    await writeFile(join(root, "real-probes-summary.json"), `${JSON.stringify({
      execution: "summarize_only",
      agents: [{ agent: "codex", blockers: ["launch_failed"] }]
    })}\n`, "utf8");
    const electronBefore = await readFile(join(root, "framework-electron.json"), "utf8");
    const tauriBefore = await readFile(join(root, "framework-tauri.json"), "utf8");
    const summaryPath = join(root, "framework-summary.json");

    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-framework-benchmark.ps1"),
      "-ArtifactRoot", root, "-SummaryPath", summaryPath
    ], { timeout: 20_000 }).catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    expect(await readFile(join(root, "framework-electron.json"), "utf8")).toBe(electronBefore);
    expect(await readFile(join(root, "framework-tauri.json"), "utf8")).toBe(tauriBefore);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      frameworks: Array<{ name: string; installSize: string; coldStart: string; weightedScore: string; rank: null; blockers: string[] }>;
      agents: Array<{ agent: string; blockers: string[] }>;
    };
    expect(summary.frameworks.map(({ name, installSize, coldStart, weightedScore, rank }) => ({
      name, installSize, coldStart, weightedScore, rank
    }))).toEqual([
      { name: "electron", installSize: "N/A", coldStart: "N/A", weightedScore: "N/A", rank: null },
      { name: "tauri", installSize: "N/A", coldStart: "N/A", weightedScore: "N/A", rank: null }
    ]);
    expect(summary.frameworks[0]?.blockers).toContain("packaged_window_exit_timeout");
    expect(summary.frameworks[1]?.blockers).toContain("rust_toolchain_download_stalled");
    expect(summary.agents).toEqual([{ agent: "codex", blockers: ["launch_failed"] }]);
  }, 20_000);

  it("suppresses every number when an otherwise eligible artifact lacks one measurement flag", async () => {
    const root = await temporaryDirectory("agenttown-framework-flags-test-");
    const electron = JSON.parse(await readFile(join(artifactRoot, "framework-electron.json"), "utf8")) as Record<string, unknown> & {
      evidence: Record<string, unknown>;
    };
    Object.assign(electron, {
      ptyStable: true,
      coreSurvivesUiExit: true,
      packageBuilds: true,
      embeddedTerminalWorks: true
    });
    Object.assign(electron.evidence, {
      blockers: [],
      measurementEligible: true,
      installSizeMeasured: false,
      coldStartMeasured: true
    });
    await writeFile(join(root, "framework-electron.json"), `${JSON.stringify(electron, null, 2)}\n`, "utf8");
    await cp(join(artifactRoot, "framework-tauri.json"), join(root, "framework-tauri.json"));
    const summaryPath = join(root, "framework-summary.json");

    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "run-framework-benchmark.ps1"),
      "-ArtifactRoot", root, "-SummaryPath", summaryPath
    ], { timeout: 20_000 }).catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as {
      frameworks: Array<Record<string, unknown>>;
    };
    expect(summary.frameworks[0]).toMatchObject({
      name: "electron",
      eligible: true,
      measurementEligible: false,
      installSize: "N/A",
      coldStart: "N/A",
      weightedScore: "N/A",
      rank: null,
      benchmarkRuns: 0
    });
  }, 20_000);

  it("uses only fixed repository-owned framework measurement paths", async () => {
    const source = await readFile(join(scriptsRoot, "run-framework-benchmark.ps1"), "utf8");
    expect(source).not.toContain("MeasurementCommand");
    expect(source).toContain("spikes\\electron\\scripts\\measure-cold-start.mjs");
    expect(source).toContain("spikes\\tauri");
    expect(source).toContain("Resolve-RepositoryPath");
    const electronMeasure = await readFile(join(repositoryRoot, "spikes", "electron", "scripts", "measure-cold-start.mjs"), "utf8");
    expect(electronMeasure).toContain('"--runs"');
    expect(electronMeasure).toContain("let runCount = 3");
  });

  it("measures an eligible framework three times through the library harness", async () => {
    const root = await temporaryDirectory("agenttown-framework-measurement-harness-test-");
    const summaryPath = join(root, "summary.json");
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "test-harness", "framework-measurement-harness.ps1"),
      "-Scenario", "success", "-SummaryPath", summaryPath
    ], { timeout: 20_000, env: { ...process.env, AGENTTOWN_FORBID_REAL_PROBES: "1" } });

    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      installSize: 42, coldStart: 20, coldStartSamples: [30, 10, 20],
      weightedScore: 83.6, rank: 1, benchmarkRuns: 3, blockers: []
    });
  }, 20_000);

  it.each([
    { scenario: "run-failure", blocker: "measurement_run_2_exit_7", benchmarkRuns: 1 },
    { scenario: "hang", blocker: "measurement_run_1_execution_timeout", benchmarkRuns: 0 },
    { scenario: "start-error", blocker: "measurement_run_1_start_error", benchmarkRuns: 0 },
    { scenario: "malformed-output", blocker: "measurement_run_1_invalid_output", benchmarkRuns: 0 }
  ])("writes summary exit 1 for framework measurement $scenario", async ({ scenario, blocker, benchmarkRuns }) => {
    const root = await temporaryDirectory(`agenttown-framework-${scenario}-test-`);
    const summaryPath = join(root, "summary.json");
    const failure = await execFileAsync("powershell.exe", [
      "-NoProfile", "-File", join(scriptsRoot, "test-harness", "framework-measurement-harness.ps1"),
      "-Scenario", scenario, "-SummaryPath", summaryPath
    ], { timeout: 20_000, env: { ...process.env, AGENTTOWN_FORBID_REAL_PROBES: "1" } })
      .catch((error: NodeJS.ErrnoException & { code?: number }) => error);

    expect(failure.code).toBe(1);
    const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Record<string, unknown>;
    expect(summary).toMatchObject({
      installSize: "N/A", coldStart: "N/A", weightedScore: "N/A", rank: null,
      benchmarkRuns, blockers: [blocker]
    });
  }, 20_000);
});
