import { describe, expect, it } from "vitest";
import { parseCompanyYaml } from "../src/company.js";

const valid = `
schema_version: 1
company:
  name: alpha
  mission: Ship a tested change
  success_criteria: [Tests pass]
  operating_rules: [Use evidence]
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer
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
  max_review_loops: 2
  max_parallel_tasks: 2
`;

describe("parseCompanyYaml", () => {
  it("parses a valid fixed roster", () => {
    const company = parseCompanyYaml(valid);
    expect(company.employees.map((employee) => employee.id)).toEqual([
      "leader",
      "developer",
      "reviewer"
    ]);
    expect(company.limits).toEqual({
      maxTaskRetry: 1,
      maxReviewLoops: 2,
      maxParallelTasks: 2
    });
    expect(company.validation).toEqual({
      commands: [],
      integrationCommandIds: []
    });
    expect(company.evidence).toEqual({
      diffWarningBytes: 2 * 1024 * 1024,
      diffHardLimitBytes: 20 * 1024 * 1024
    });
  });

  it.each([
    ["duplicate employee", `${valid}\n  - id: leader\n    role: duplicate\n    agent: fake\n    reports_to: owner\n    workspace: read_only`],
    ["unknown manager", valid.replace("reports_to: leader", "reports_to: missing")],
    ["reporting cycle", valid.replace("reports_to: owner", "reports_to: developer")],
    ["retry above one", valid.replace("max_task_retry: 1", "max_task_retry: 2")],
    ["review loops above two", valid.replace("max_review_loops: 2", "max_review_loops: 3")]
  ])("rejects %s", (_name, text) => {
    expect(() => parseCompanyYaml(text)).toThrow();
  });

  it.each([
    ["unknown integration command", `${valid}\nvalidation:\n  commands: []\n  integration_command_ids: [unit-tests]`],
    ["warning limit above hard limit", `${valid}\nevidence:\n  diff_warning_bytes: 20971520\n  diff_hard_limit_bytes: 2097152`],
    ["absolute validation cwd", `${valid}\nvalidation:\n  commands:\n    - id: unit-tests\n      executable: pnpm\n      args: [test]\n      cwd: C:\\\\repo\n      timeout_seconds: 60\n  integration_command_ids: []`]
  ])("rejects %s configuration", (_name, text) => {
    expect(() => parseCompanyYaml(text)).toThrow();
  });
});
