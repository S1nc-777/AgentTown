import { describe, expect, it } from "vitest";
import {
  parseCompanyYaml,
  parseGitTaskSubmission,
  parseReviewDecision
} from "../src/index.js";

const commit = "a".repeat(40);
const manifestHash = "b".repeat(64);

describe("P1B Git contract", () => {
  it("parses a continuous declared submission shape", () => {
    expect(parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: ["unit-tests"],
      suggestedValidationCommands: [],
      reportedResults: [{
        commandId: "unit-tests",
        outcome: "passed",
        summary: "12 tests passed"
      }],
      knownRisks: []
    }).commits).toHaveLength(1);
  });

  it("rejects an approving review with a blocking finding", () => {
    expect(() => parseReviewDecision({
      schemaVersion: 1,
      decision: "approve",
      findings: [{
        severity: "blocking",
        evidence: "test failed",
        requiredChange: "fix it"
      }],
      coverageGaps: [],
      summary: "not actually approved",
      reviewedManifestHash: manifestHash
    })).toThrow("approve");
  });

  it("rejects a review rejection without a blocking required change", () => {
    expect(() => parseReviewDecision({
      schemaVersion: 1,
      decision: "reject",
      findings: [{
        severity: "blocking",
        evidence: "test failed",
        requiredChange: null
      }],
      coverageGaps: [],
      summary: "needs work",
      reviewedManifestHash: manifestHash
    })).toThrow("reject");
  });

  it("rejects duplicate submission commits", () => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit, commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
  });

  it("rejects a submission whose commits do not end at its declared head", () => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: ["c".repeat(40)],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
  });

  it("rejects a suggested validation command outside its workspace", () => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [{
        id: "unit-tests",
        executable: "pnpm",
        args: ["test"],
        cwd: "../outside",
        timeoutSeconds: 60
      }],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
  });

  it("accepts the 3600-second validation timeout boundary", () => {
    expect(parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [{
        id: "unit-tests",
        executable: "pnpm",
        args: ["test"],
        cwd: ".",
        timeoutSeconds: 3600
      }],
      reportedResults: [],
      knownRisks: []
    }).suggestedValidationCommands[0]?.timeoutSeconds).toBe(3600);
  });

  it("rejects validation timeouts above 3600 seconds", () => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [{
        id: "unit-tests",
        executable: "pnpm",
        args: ["test"],
        cwd: ".",
        timeoutSeconds: 3601
      }],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
  });

  it.each(["C:outside", "c:outside"])("rejects volume-qualified cwd %s", (cwd) => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [{
        id: "unit-tests",
        executable: "pnpm",
        args: ["test"],
        cwd,
        timeoutSeconds: 60
      }],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
  });

  it("accepts a safe relative validation cwd", () => {
    expect(parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: commit,
      commits: [commit],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [{
        id: "unit-tests",
        executable: "pnpm",
        args: ["test"],
        cwd: "packages/runtime-contract",
        timeoutSeconds: 60
      }],
      reportedResults: [],
      knownRisks: []
    }).suggestedValidationCommands[0]?.cwd).toBe("packages/runtime-contract");
  });

  it("rejects uppercase or incorrectly sized Git and manifest hashes", () => {
    expect(() => parseGitTaskSubmission({
      schemaVersion: 1,
      headCommit: "A".repeat(40),
      commits: ["A".repeat(40)],
      changeSummary: "Add greeting",
      validationCommandIds: [],
      suggestedValidationCommands: [],
      reportedResults: [],
      knownRisks: []
    })).toThrow();
    expect(() => parseReviewDecision({
      schemaVersion: 1,
      decision: "approve",
      findings: [],
      coverageGaps: [],
      summary: "approved",
      reviewedManifestHash: "b".repeat(63)
    })).toThrow();
  });

  it("parses structured validation commands and exact limits", () => {
    const company = parseCompanyYaml(`
schema_version: 1
company:
  name: Test
  mission: Test Git collaboration
  success_criteria: [Integrated]
  operating_rules: [No push]
employees:
  - id: leader
    role: leader
    agent: fake
    reports_to: owner
    workspace: read_only
limits:
  max_task_retry: 1
  max_review_loops: 2
  max_parallel_tasks: 2
validation:
  commands:
    - id: unit-tests
      executable: pnpm
      args: [test]
      cwd: .
      timeout_seconds: 600
  integration_command_ids: [unit-tests]
evidence:
  diff_warning_bytes: 2097152
  diff_hard_limit_bytes: 20971520
`);
    expect(company.validation.commands[0]?.timeoutSeconds).toBe(600);
    expect(company.evidence.diffHardLimitBytes).toBe(20 * 1024 * 1024);
  });
});
