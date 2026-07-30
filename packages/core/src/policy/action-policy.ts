import type {
  ActionProposal,
  ActionType,
  CompanyDefinition,
  TaskRecord
} from "@agenttown/runtime-contract";

const supportedActions = new Set<ActionType>([
  "task.propose",
  "task.assign",
  "task.start",
  "task.submit",
  "task.request_review",
  "task.approve",
  "task.reject",
  "task.block",
  "employee.message",
  "user.approval.request",
  "company.complete.request"
]);

const leaderOnlyActions = new Set<ActionType>([
  "task.propose",
  "task.assign",
  "company.complete.request"
]);

export class ActionPolicy {
  readonly #authorizedReviewerIds: ReadonlySet<string>;

  constructor(
    private readonly company: CompanyDefinition,
    private readonly leaderId: string,
    reviewerIds: ReadonlySet<string>,
    private readonly taskLookup?: (taskId: string) => TaskRecord | null
  ) {
    for (const reviewerId of reviewerIds) {
      const reviewer = company.employees.find(({ id }) => id === reviewerId);
      if (reviewer === undefined || reviewer.workspace !== "review_package") {
        throw new Error(`invalid configured reviewer: ${reviewerId}`);
      }
    }
    this.#authorizedReviewerIds = new Set(reviewerIds);
  }

  validate(action: ActionProposal): ActionProposal {
    if (!supportedActions.has(action.type)) {
      throw new Error(`unsupported action: ${String(action.type)}`);
    }

    const actor = this.company.employees.find(
      (employee) => employee.id === action.actorEmployeeId
    );
    if (actor === undefined) {
      throw new Error(`unknown employee: ${action.actorEmployeeId}`);
    }

    if (leaderOnlyActions.has(action.type) && action.actorEmployeeId !== this.leaderId) {
      throw new Error("leader permission required");
    }

    if (action.type === "task.assign") {
      const assignee = action.payload.assignee;
      const employee = typeof assignee === "string"
        ? this.company.employees.find(({ id }) => id === assignee)
        : undefined;
      if (employee === undefined) {
        throw new Error(`unknown assignee: ${String(assignee)}`);
      }
      if (employee.workspace !== "git_worktree") {
        throw new Error("task assignee requires git_worktree workspace");
      }
    }

    if (
      (action.type === "task.approve" || action.type === "task.reject")
      && (
        !this.#authorizedReviewerIds.has(action.actorEmployeeId)
        || actor.workspace !== "review_package"
      )
    ) {
      throw new Error("review permission required");
    }
    if (
      (action.type === "task.approve" || action.type === "task.reject")
      && action.taskId !== null
      && this.taskLookup?.(action.taskId)?.ownerEmployeeId === action.actorEmployeeId
    ) {
      throw new Error("task owner cannot review their own submission");
    }

    if (action.type === "employee.message") {
      const recipient = action.payload.recipient;
      if (
        typeof recipient !== "string"
        || !this.company.employees.some((employee) => employee.id === recipient)
      ) {
        throw new Error(`unknown recipient: ${String(recipient)}`);
      }
    }

    return action;
  }
}
