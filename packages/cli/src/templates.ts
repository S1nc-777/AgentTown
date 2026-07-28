const minimal = `schema_version: 1
company:
  name: minimal
  mission: Complete the user-confirmed task
  success_criteria:
    - All task acceptance criteria pass
    - Independent review passes
  operating_rules:
    - Each task has one owner
    - Every completion includes evidence
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
  max_parallel_tasks: 1
`;

const parallelSoftware = `schema_version: 1
company:
  name: parallel-software
  mission: Deliver a runnable and tested small software project
  success_criteria:
    - All confirmed acceptance criteria pass
    - Project verification passes
    - Independent review passes
  operating_rules:
    - Each task has one owner
    - Every conclusion includes evidence
    - Requirement ambiguity is escalated to the user
employees:
  - id: leader
    role: product_lead
    agent: fake
    reports_to: owner
    workspace: read_only
  - id: developer-a
    role: developer
    agent: fake
    reports_to: leader
    workspace: git_worktree
  - id: developer-b
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

export type TemplateName = "minimal" | "parallel-software";

export function templateYaml(name: TemplateName): string {
  return name === "minimal" ? minimal : parallelSoftware;
}
