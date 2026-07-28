import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWithinProject,
  pipeNameForProject,
  resolveAgentTownPaths,
  validateAgentTownWriteLayout
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

  it("rejects a symlinked or junction-backed .agenttown before writing", async () => {
    const project = await mkdtemp(join(tmpdir(), "agenttown-cli-path-project-"));
    const outside = await mkdtemp(join(tmpdir(), "agenttown-cli-path-outside-"));
    const paths = resolveAgentTownPaths(project);
    await mkdir(outside, { recursive: true });
    try {
      try {
        await symlink(
          outside,
          paths.stateDir,
          process.platform === "win32" ? "junction" : "dir"
        );
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
      await expect(validateAgentTownWriteLayout(paths))
        .rejects.toThrow(/symbolic|junction/u);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
