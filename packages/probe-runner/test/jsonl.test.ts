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
    expect(reader.end()).toEqual([]);
  });

  it("accepts CRLF delimiters", () => {
    const reader = new JsonlReader();
    expect(reader.push("first\r\nsecond\r\n")).toEqual(["first", "second"]);
  });

  it("reassembles a CRLF delimiter split across chunks", () => {
    const reader = new JsonlReader();
    expect(reader.push("first\r")).toEqual([]);
    expect(reader.push("\nsecond\r")).toEqual(["first"]);
    expect(reader.push("\n")).toEqual(["second"]);
  });

  it("returns multiple complete lines from one chunk", () => {
    const reader = new JsonlReader();
    expect(reader.push("first\nsecond\nthird\n")).toEqual(["first", "second", "third"]);
  });
});
