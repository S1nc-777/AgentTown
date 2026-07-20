import { describe, expect, it } from "vitest";
import { JsonlReader } from "../src/jsonl.js";

describe("JsonlReader", () => {
  it("reassembles lines split across chunks", () => {
    const reader = new JsonlReader();
    expect(reader.push('{"type":"ready",')).toEqual([]);
    expect(reader.push('"pid":7}\n')).toEqual(['{"type":"ready","pid":7}']);
  });

  it("flushes the final line without a newline", () => {
    const reader = new JsonlReader();
    reader.push("tail");
    expect(reader.end()).toEqual(["tail"]);
  });
});
