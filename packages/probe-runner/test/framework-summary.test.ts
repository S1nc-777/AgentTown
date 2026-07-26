import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  renderFrameworkTable,
  summarizeFrameworks,
  type FrameworkArtifact
} from "../src/framework-summary.js";

const artifactRoot = fileURLToPath(new URL("../../../artifacts/feasibility/", import.meta.url));
const execFileAsync = promisify(execFile);

async function artifact(name: string): Promise<FrameworkArtifact> {
  return JSON.parse(await readFile(`${artifactRoot}/framework-${name}.json`, "utf8")) as FrameworkArtifact;
}

describe("summarizeFrameworks", () => {
  it("suppresses ineligible and unmeasured numbers while preserving exact blockers", async () => {
    const summary = summarizeFrameworks([await artifact("electron"), await artifact("tauri")]);

    expect(summary.map(({ name, installSize, coldStart, weightedScore, rank }) => ({
      name, installSize, coldStart, weightedScore, rank
    }))).toEqual([
      { name: "electron", installSize: "N/A", coldStart: "N/A", weightedScore: "N/A", rank: null },
      { name: "tauri", installSize: "N/A", coldStart: "N/A", weightedScore: "N/A", rank: null }
    ]);
    expect(summary[0]?.blockers).toEqual(["core_survival", "packaged_window_exit_timeout"]);
    expect(summary[1]?.blockers).toEqual([
      "pty_stability",
      "core_survival",
      "packaging",
      "terminal_embedding",
      "rust_toolchain_download_stalled"
    ]);
    expect(JSON.stringify(summary)).not.toContain("497.03");
    expect(JSON.stringify(summary)).not.toContain('"weightedScore":100');
  });

  it("ranks only eligible candidates with measured evidence", () => {
    const eligible: FrameworkArtifact = {
      name: "electron",
      ptyStable: true,
      coreSurvivesUiExit: true,
      packageBuilds: true,
      embeddedTerminalWorks: true,
      installSizeMb: 100,
      coldStartMs: 500,
      implementationMinutes: 50,
      evidence: {
        blockers: [],
        measurementEligible: true,
        installSizeMeasured: true,
        coldStartMeasured: true
      }
    };

    expect(summarizeFrameworks([eligible])).toEqual([expect.objectContaining({
      name: "electron",
      installSize: 100,
      coldStart: 500,
      weightedScore: 75,
      rank: 1,
      blockers: []
    })]);
  });

  it.each([
    ["measurement eligibility", { measurementEligible: false, installSizeMeasured: true, coldStartMeasured: true }],
    ["install-size evidence", { measurementEligible: true, installSizeMeasured: false, coldStartMeasured: true }],
    ["cold-start evidence", { measurementEligible: true, installSizeMeasured: true, coldStartMeasured: false }]
  ] as const)("suppresses all comparable numbers when %s is false", (_name, evidence) => {
    const row = summarizeFrameworks([{
      name: "electron",
      ptyStable: true,
      coreSurvivesUiExit: true,
      packageBuilds: true,
      embeddedTerminalWorks: true,
      installSizeMb: 123,
      coldStartMs: 456,
      implementationMinutes: 78,
      evidence: { blockers: [], ...evidence }
    }])[0];

    expect(row).toMatchObject({
      eligible: true,
      measurementEligible: false,
      installSize: "N/A",
      coldStart: "N/A",
      weightedScore: "N/A",
      rank: null
    });
  });

  it("renders suppressed values as N/A without leaking placeholder scores", async () => {
    const table = renderFrameworkTable(summarizeFrameworks([
      await artifact("electron"),
      await artifact("tauri")
    ]));

    expect(table).toContain("| Framework | Eligible | Install MiB | Cold start ms | Weighted score | Implementation minutes | Rank | Blockers |");
    expect(table).toContain("| electron | no | N/A | N/A | N/A | 60 | - | core_survival, packaged_window_exit_timeout |");
    expect(table).toContain("| tauri | no | N/A | N/A | N/A | 15 | - |");
    expect(table).not.toContain("497.03");
  });

  it.runIf(process.platform === "win32")("uses a valid Windows artifact path before returning hard-gate exit 1", async () => {
    const failure = await execFileAsync(process.execPath, [
      "--import", "tsx", "src/score-frameworks.ts"
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 20_000,
      env: {
        ...process.env,
        AGENTTOWN_FORBID_REAL_PROBES: "1",
        AGENTTOWN_REAL_CODEX: "0",
        AGENTTOWN_REAL_CLAUDE: "0"
      }
    }).catch((error: NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }) => error);

    expect(failure.code).toBe(1);
    expect(failure.stdout).toContain("| electron | no | N/A | N/A | N/A |");
    expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).not.toContain("ENOENT");
  });
});
