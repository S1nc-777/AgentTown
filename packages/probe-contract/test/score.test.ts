import { describe, expect, it } from "vitest";
import { scoreFramework } from "../src/index.js";

describe("scoreFramework", () => {
  it("rejects a candidate that cannot keep the core alive", () => {
    const result = scoreFramework({
      name: "electron",
      ptyStable: true,
      coreSurvivesUiExit: false,
      packageBuilds: true,
      embeddedTerminalWorks: true,
      installSizeMb: 80,
      coldStartMs: 900,
      implementationMinutes: 40
    });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain("core_survival");
  });

  it("returns a rounded weighted score for an eligible candidate", () => {
    expect(scoreFramework({
      name: "tauri",
      ptyStable: true,
      coreSurvivesUiExit: true,
      packageBuilds: true,
      embeddedTerminalWorks: true,
      installSizeMb: 81,
      coldStartMs: 905,
      implementationMinutes: 203
    })).toEqual({ eligible: true, blockers: [], score: 42.8 });
  });

  it("reports every failed hard gate", () => {
    expect(scoreFramework({
      name: "electron",
      ptyStable: false,
      coreSurvivesUiExit: false,
      packageBuilds: false,
      embeddedTerminalWorks: false,
      installSizeMb: 0,
      coldStartMs: 0,
      implementationMinutes: 0
    }).blockers).toEqual(["pty_stability", "core_survival", "packaging", "terminal_embedding"]);
  });
});
