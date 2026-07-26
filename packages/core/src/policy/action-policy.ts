import type {
  ActionProposal,
  ActionType,
  CompanyDefinition
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
  constructor(
    private readonly company: CompanyDefinition,
    private readonly leaderId: string,
    private readonly reviewerIds: ReadonlySet<string>
  ) {}

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
      if (
        typeof assignee !== "string"
        || !this.company.employees.some((employee) => employee.id === assignee)
      ) {
        throw new Error(`unknown assignee: ${String(assignee)}`);
      }
    }

    if (
      (action.type === "task.approve" || action.type === "task.reject")
      && !this.reviewerIds.has(action.actorEmployeeId)
    ) {
      throw new Error("review permission required");
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
