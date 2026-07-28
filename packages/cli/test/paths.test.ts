import { describe, expect, it } from "vitest";
import {
  assertWithinProject,
  pipeNameForProject,
  resolveAgentTownPaths
} from "../src/paths.js";

describe("AgentTown paths", () => {
  it("resolves all state beneath the selected project", () => {
    const paths = resolveAgentTownPaths("C:\\work\\project");
    expect(paths.stateDir).toBe("C:\\work\\project\\.agenttown");
    expect(paths.databasePath.startsWith(paths.stateDir)).toBe(true);
    expect(paths.companyPath.startsWith(paths.stateDir)).toBe(true);
  });

  it("rejects a state path that escapes the project", () => {
    expect(() => assertWithinProject("C:\\work\\project", "C:\\work\\other"))
      .toThrow("outside project");
  });

  it("derives a stable per-user, per-project pipe name", () => {
    const first = pipeNameForProject("C:\\work\\project", {
      username: "alice",
      homedir: "C:\\Users\\alice"
    });
    const repeat = pipeNameForProject("c:\\WORK\\project\\.", {
      username: "alice",
      homedir: "c:\\users\\ALICE"
    });
    const second = pipeNameForProject("C:\\work\\project", {
      username: "bob",
      homedir: "C:\\Users\\bob"
    });
    expect(first).toMatch(/^agenttown-[a-f0-9]{24}$/u);
    expect(repeat).toBe(first);
    expect(second).not.toBe(first);
  });

  it("rejects case-insensitive Windows escapes and different drives", () => {
    expect(() => assertWithinProject("C:\\Work\\Project", "C:\\Work\\Project2"))
      .toThrow("outside project");
    expect(() => assertWithinProject("C:\\Work\\Project", "D:\\Work\\Project"))
      .toThrow("outside project");
  });
});
