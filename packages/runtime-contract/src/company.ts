import { parse } from "yaml";
import { z } from "zod";
import { validationCommandSchema, type ValidationCommand } from "./git.js";

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
  validation: {
    commands: ValidationCommand[];
    integrationCommandIds: string[];
  };
  evidence: {
    diffWarningBytes: number;
    diffHardLimitBytes: number;
  };
}

const nonEmpty = z.string().trim().min(1);
const employeeId = nonEmpty.regex(/^[a-z][a-z0-9_-]*$/u);
const validationCommandInputSchema = z.object({
  id: employeeId,
  executable: nonEmpty,
  args: z.array(nonEmpty),
  cwd: nonEmpty,
  timeout_seconds: z.number().int()
}).transform(({ timeout_seconds, ...command }) => validationCommandSchema.parse({
  ...command,
  timeoutSeconds: timeout_seconds
}));
const validationInputSchema = z.object({
  commands: z.array(validationCommandInputSchema),
  integration_command_ids: z.array(employeeId)
}).default({ commands: [], integration_command_ids: [] });
const evidenceInputSchema = z.object({
  diff_warning_bytes: z.number().int().min(256 * 1024).max(20 * 1024 * 1024),
  diff_hard_limit_bytes: z.number().int().min(1024 * 1024).max(100 * 1024 * 1024)
}).default({
  diff_warning_bytes: 2 * 1024 * 1024,
  diff_hard_limit_bytes: 20 * 1024 * 1024
});
const companyInputSchema = z.object({
  schema_version: z.literal(1),
  company: z.object({
    name: nonEmpty,
    mission: nonEmpty,
    success_criteria: z.array(nonEmpty).min(1),
    operating_rules: z.array(nonEmpty).min(1)
  }),
  employees: z.array(z.object({
    id: employeeId,
    role: nonEmpty,
    agent: nonEmpty,
    reports_to: nonEmpty,
    workspace: z.enum(workspaceModes)
  })).min(1),
  limits: z.object({
    max_task_retry: z.union([z.literal(0), z.literal(1)]),
    max_review_loops: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    max_parallel_tasks: z.number().int().positive()
  }),
  validation: validationInputSchema,
  evidence: evidenceInputSchema
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
  const commandIds = new Set<string>();
  for (const command of company.validation.commands) {
    if (commandIds.has(command.id)) throw new Error(`duplicate validation command id: ${command.id}`);
    commandIds.add(command.id);
  }
  for (const commandId of company.validation.integrationCommandIds) {
    if (!commandIds.has(commandId)) {
      throw new Error(`unknown integration command id: ${commandId}`);
    }
  }
  if (company.evidence.diffWarningBytes > company.evidence.diffHardLimitBytes) {
    throw new Error("diff warning bytes cannot exceed hard limit bytes");
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
    },
    validation: {
      commands: input.validation.commands,
      integrationCommandIds: input.validation.integration_command_ids
    },
    evidence: {
      diffWarningBytes: input.evidence.diff_warning_bytes,
      diffHardLimitBytes: input.evidence.diff_hard_limit_bytes
    }
  });
}
