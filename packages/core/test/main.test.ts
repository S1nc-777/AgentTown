import { describe, expect, it } from "vitest";
import {
  assertCorePathWithinProject,
  parseCoreArguments
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
  });
});
