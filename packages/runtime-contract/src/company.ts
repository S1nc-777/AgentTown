import { parse } from "yaml";
import { z } from "zod";

export const workspaceModes = ["read_only", "git_worktree", "review_package"] as const;
export type WorkspaceMode = typeof workspaceModes[number];

export interface EmployeeDefinition {
  id: string;
  role: string;
  agent: string;
  reportsTo: "owner" | string;
  workspace: WorkspaceMode;
}

export interface CompanyDefinition {
  schemaVersion: 1;
  company: {
    name: string;
    mission: string;
    successCriteria: string[];
    operatingRules: string[];
  };
  employees: EmployeeDefinition[];
  limits: {
    maxTaskRetry: 0 | 1;
    maxReviewLoops: 0 | 1 | 2;
    maxParallelTasks: number;
  };
}

const nonEmpty = z.string().trim().min(1);
const companyInputSchema = z.object({
  schema_version: z.literal(1),
  company: z.object({
    name: nonEmpty,
    mission: nonEmpty,
    success_criteria: z.array(nonEmpty).min(1),
    operating_rules: z.array(nonEmpty).min(1)
  }),
  employees: z.array(z.object({
    id: nonEmpty.regex(/^[a-z][a-z0-9_-]*$/u),
    role: nonEmpty,
    agent: nonEmpty,
    reports_to: nonEmpty,
    workspace: z.enum(workspaceModes)
  })).min(1),
  limits: z.object({
    max_task_retry: z.union([z.literal(0), z.literal(1)]),
    max_review_loops: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    max_parallel_tasks: z.number().int().positive()
  })
});

function validateOrganization(company: CompanyDefinition): CompanyDefinition {
  const ids = new Set<string>();
  for (const employee of company.employees) {
    if (ids.has(employee.id)) throw new Error(`duplicate employee id: ${employee.id}`);
    ids.add(employee.id);
  }
  for (const employee of company.employees) {
    if (employee.reportsTo !== "owner" && !ids.has(employee.reportsTo)) {
      throw new Error(`unknown reports_to: ${employee.reportsTo}`);
    }
  }
  for (const employee of company.employees) {
    const visited = new Set<string>([employee.id]);
    let manager = employee.reportsTo;
    while (manager !== "owner") {
      if (visited.has(manager)) throw new Error(`reporting cycle at: ${manager}`);
      visited.add(manager);
      const record = company.employees.find((item) => item.id === manager);
      if (record === undefined) throw new Error(`unknown reports_to: ${manager}`);
      manager = record.reportsTo;
    }
  }
  return company;
}

export function parseCompanyYaml(text: string): CompanyDefinition {
  const input = companyInputSchema.parse(parse(text));
  return validateOrganization({
    schemaVersion: 1,
    company: {
      name: input.company.name,
      mission: input.company.mission,
      successCriteria: input.company.success_criteria,
      operatingRules: input.company.operating_rules
    },
    employees: input.employees.map((employee) => ({
      id: employee.id,
      role: employee.role,
      agent: employee.agent,
      reportsTo: employee.reports_to,
      workspace: employee.workspace
    })),
    limits: {
      maxTaskRetry: input.limits.max_task_retry,
      maxReviewLoops: input.limits.max_review_loops,
      maxParallelTasks: input.limits.max_parallel_tasks
    }
  });
}
