import { parseCompanyYaml, type CompanyDefinition } from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { templateYaml } from "../src/templates.js";

function assertAuthoritativeValidation(company: CompanyDefinition): void {
  expect(company.validation.commands.length).toBeGreaterThan(0);
  const commandIds = new Set(company.validation.commands.map(({ id }) => id));
  expect(company.validation.integrationCommandIds.length).toBeGreaterThan(0);
  expect(company.validation.integrationCommandIds.every((id) =>
    commandIds.has(id)
  )).toBe(true);
  for (const command of company.validation.commands) {
    expect(command.executable.length).toBeGreaterThan(0);
    expect(command.cwd.startsWith("/")).toBe(false);
    expect(command.cwd.includes("..")).toBe(false);
    expect(command.timeoutSeconds).toBeGreaterThan(0);
  }
  expect(company.validation.commands.some(({ id }) =>
    id === "git-clean"
  )).toBe(true);
}

describe("company templates", () => {
  it.each(["minimal", "parallel-software"] as const)("parses %s", (name) => {
    const company = parseCompanyYaml(templateYaml(name));
    expect(company.employees.length).toBeGreaterThanOrEqual(3);
    expect(company.employees.every((employee) => employee.agent === "fake")).toBe(true);
  });

  it("configures authoritative validation for the parallel-software template", () => {
    assertAuthoritativeValidation(
      parseCompanyYaml(templateYaml("parallel-software"))
    );
  });

  it("parses codex-lead-software with a codex leader and fake employees", () => {
    const company = parseCompanyYaml(templateYaml("codex-lead-software"));
    expect(company.employees.length).toBe(4);
    const byId = new Map(company.employees.map((employee) => [employee.id, employee]));
    expect(byId.get("leader")?.agent).toBe("codex");
    expect(byId.get("developer-a")?.agent).toBe("fake");
    expect(byId.get("developer-b")?.agent).toBe("fake");
    expect(byId.get("reviewer")?.agent).toBe("fake");
  });

  it("configures authoritative validation for the codex-lead-software template", () => {
    assertAuthoritativeValidation(
      parseCompanyYaml(templateYaml("codex-lead-software"))
    );
  });
});
