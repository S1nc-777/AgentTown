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
});
