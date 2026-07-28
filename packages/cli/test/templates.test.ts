import { parseCompanyYaml } from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { templateYaml } from "../src/templates.js";

describe("company templates", () => {
  it.each(["minimal", "parallel-software"] as const)("parses %s", (name) => {
    const company = parseCompanyYaml(templateYaml(name));
    expect(company.employees.length).toBeGreaterThanOrEqual(3);
    expect(company.employees.every((employee) => employee.agent === "fake")).toBe(true);
  });
});
