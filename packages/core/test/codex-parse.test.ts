import { describe, expect, it } from "vitest";
import type { ActionProposal } from "@agenttown/runtime-contract";
import {
  extractStructuredAction,
  parseCodexJsonl
} from "../src/agents/codex-parse.js";

function validProposal(): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: "action-1",
    type: "task.start",
    actorEmployeeId: "alice",
    taskId: "task-1",
    payload: { note: "go" },
    reason: "ready to start",
    causationEventId: null
  };
}

describe("parseCodexJsonl", () => {
  it("maps thread.started to session.started with the native thread id", () => {
    const events = parseCodexJsonl(
      JSON.stringify({ type: "thread.started", thread_id: "t-1" })
    );
    expect(events).toEqual([
      {
        type: "session.started",
        handle: {
          employeeId: "",
          adapter: "codex",
          internalSessionId: "",
          nativeSessionId: "t-1"
        }
      }
    ]);
  });

  it("maps item.completed agent_message to output.completed", () => {
    const events = parseCodexJsonl(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello world" }
      })
    );
    expect(events).toEqual([{ type: "output.completed", text: "hello world" }]);
  });

  it("maps turn.completed usage to usage.updated", () => {
    const events = parseCodexJsonl(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 }
      })
    );
    expect(events).toEqual([
      {
        type: "usage.updated",
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      }
    ]);
  });

  it("maps turn.failed to adapter.error", () => {
    const events = parseCodexJsonl(
      JSON.stringify({ type: "turn.failed", message: "model errored" })
    );
    expect(events).toEqual([
      {
        type: "adapter.error",
        code: "codex_error",
        message: "model errored"
      }
    ]);
  });

  it("maps error events to adapter.error using the nested error message", () => {
    const events = parseCodexJsonl(
      JSON.stringify({ type: "error", error: { message: "auth failed" } })
    );
    expect(events).toEqual([
      {
        type: "adapter.error",
        code: "codex_error",
        message: "auth failed"
      }
    ]);
  });

  it("returns an empty array for invalid JSON", () => {
    expect(parseCodexJsonl("this is not json")).toEqual([]);
    expect(parseCodexJsonl("{")).toEqual([]);
  });

  it("returns an empty array when the line is valid JSON but not an object", () => {
    expect(parseCodexJsonl("42")).toEqual([]);
    expect(parseCodexJsonl("null")).toEqual([]);
  });

  it("returns an empty array for an unrecognized event type", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "something.else" }))).toEqual(
      []
    );
  });

  it("returns an empty array for thread.started without a thread_id", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "thread.started" }))).toEqual(
      []
    );
  });

  it("returns an empty array for item.completed without agent_message text", () => {
    expect(
      parseCodexJsonl(
        JSON.stringify({ type: "item.completed", item: { type: "tool_call" } })
      )
    ).toEqual([]);
    expect(
      parseCodexJsonl(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message" } })
      )
    ).toEqual([]);
  });

  it("returns an empty array for turn.completed without numeric usage", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.completed" }))).toEqual(
      []
    );
    expect(
      parseCodexJsonl(
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: "ten", output_tokens: 5 }
        })
      )
    ).toEqual([]);
  });

  it("returns an empty array for turn.failed without an extractable message", () => {
    expect(parseCodexJsonl(JSON.stringify({ type: "turn.failed" }))).toEqual([]);
  });
});

describe("extractStructuredAction", () => {
  it("extracts and validates an ActionProposal from a json fenced block", () => {
    const proposal = validProposal();
    const text = `Here is the plan:\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\`\nDone.`;
    expect(extractStructuredAction(text)).toEqual(proposal);
  });

  it("extracts an ActionProposal from an ACTION: line", () => {
    const proposal = validProposal();
    const text = `ACTION: ${JSON.stringify(proposal)}`;
    expect(extractStructuredAction(text)).toEqual(proposal);
  });

  it("extracts from a fenced block whose first line is the FORMAT_INSTRUCTION ACTION: prefix", () => {
    const proposal = validProposal();
    const text = [
      "Understood. Here is my next action.",
      "```json",
      `ACTION: ${JSON.stringify(proposal)}`,
      "```"
    ].join("\n");
    expect(extractStructuredAction(text)).toEqual(proposal);
  });

  it("extracts from a fenced block with a lowercase action: prefix", () => {
    const proposal = validProposal();
    const text = ["```json", `action: ${JSON.stringify(proposal)}`, "```"].join(
      "\n"
    );
    expect(extractStructuredAction(text)).toEqual(proposal);
  });

  it("extracts from a fenced block with leading whitespace before the ACTION: prefix", () => {
    const proposal = validProposal();
    const text = `\`\`\`json\n   ACTION: ${JSON.stringify(proposal)}\n\`\`\``;
    expect(extractStructuredAction(text)).toEqual(proposal);
  });

  it("returns null when a fenced block has ACTION: followed by invalid JSON", () => {
    const text = "```json\nACTION: { not json }\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when a fenced block has ACTION: followed by nothing", () => {
    const text = "```json\nACTION:\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when the fenced block contains malformed JSON", () => {
    const text = "```json\n{ not json }\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when the fenced payload is not an object", () => {
    const text = "```json\n\"hello\"\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const incomplete = validProposal();
    delete (incomplete as Partial<ActionProposal>).reason;
    const text = "```json\n" + JSON.stringify(incomplete) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when schemaVersion is not 1", () => {
    const wrong = { ...validProposal(), schemaVersion: 2 };
    const text = "```json\n" + JSON.stringify(wrong) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when the action type is not in the known set", () => {
    const wrong = { ...validProposal(), type: "task.teleport" };
    const text = "```json\n" + JSON.stringify(wrong) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when actionId is empty", () => {
    const wrong = { ...validProposal(), actionId: "" };
    const text = "```json\n" + JSON.stringify(wrong) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when payload is not an object", () => {
    const wrong = { ...validProposal(), payload: "nope" };
    const text = "```json\n" + JSON.stringify(wrong) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when taskId has an invalid type", () => {
    const wrong = { ...validProposal(), taskId: 42 };
    const text = "```json\n" + JSON.stringify(wrong) + "\n```";
    expect(extractStructuredAction(text)).toBeNull();
  });

  it("returns null when there is no json block or ACTION line", () => {
    expect(extractStructuredAction("just plain text")).toBeNull();
  });
});
