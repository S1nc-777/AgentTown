export type CoreRequest =
  | { type: "health" }
  | { type: "start_fake"; mode: "normal" | "slow" }
  | { type: "input"; text: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "shutdown" };

export type DecodeResult =
  | { ok: true; value: unknown }
  | { ok: false; code: "malformed_json" };

export type ParseResult =
  | { ok: true; value: CoreRequest }
  | { ok: false; code: "unknown_request" | "invalid_request" };

export class JsonLineDecoder {
  #buffer = "";

  push(chunk: string): DecodeResult[] {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.map((line) => {
      try {
        return { ok: true, value: JSON.parse(line) } as const;
      } catch {
        return { ok: false, code: "malformed_json" } as const;
      }
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCoreRequest(value: unknown): ParseResult {
  if (!isRecord(value) || typeof value.type !== "string") return { ok: false, code: "invalid_request" };
  switch (value.type) {
    case "health":
    case "shutdown":
      return Object.keys(value).length === 1
        ? { ok: true, value: { type: value.type } }
        : { ok: false, code: "invalid_request" };
    case "start_fake":
      return Object.keys(value).length === 2 && (value.mode === "normal" || value.mode === "slow")
        ? { ok: true, value: { type: value.type, mode: value.mode } }
        : { ok: false, code: "invalid_request" };
    case "input":
      return Object.keys(value).length === 2 && typeof value.text === "string"
        ? { ok: true, value: { type: value.type, text: value.text } }
        : { ok: false, code: "invalid_request" };
    case "resize":
      return Object.keys(value).length === 3 &&
        Number.isInteger(value.cols) &&
        Number.isInteger(value.rows) &&
        (value.cols as number) > 0 &&
        (value.rows as number) > 0
        ? { ok: true, value: { type: value.type, cols: value.cols as number, rows: value.rows as number } }
        : { ok: false, code: "invalid_request" };
    default:
      return { ok: false, code: "unknown_request" };
  }
}

export function encodeMessage(value: object): string {
  return `${JSON.stringify(value)}\n`;
}
