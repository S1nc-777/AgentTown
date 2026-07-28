import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertCorePathWithinProject,
  createShutdownCoordinator,
  parseCoreArguments,
  validateCoreStateLayout
} from "../src/main.js";

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
