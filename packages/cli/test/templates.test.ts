import { parseCompanyYaml } from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { templateYaml } from "../src/templates.js";

describe("company templates", () => {
  it.each(["minimal", "parallel-software"] as const)("parses %s", (name) => {
    const company = parseCompanyYaml(templateYaml(name));
    expect(company.employees.length).toBeGreaterThanOrEqual(3);
    expect(company.employees.every((employee) => employee.agent === "fake")).toBe(true);
  });

  it("configures authoritative validation for the parallel-software template", () => {
    const company = parseCompanyYaml(templateYaml("parallel-software"));
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
  });
});
