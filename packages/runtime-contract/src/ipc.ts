import { z } from "zod";

export const IPC_PROTOCOL_VERSION = 1 as const;

export type IpcRequest = {
  protocolVersion: 1;
  kind: "request";
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

export type IpcResponse = {
  protocolVersion: 1;
  kind: "response";
  requestId: string;
  ok: boolean;
  result: unknown;
  error: { code: string; message: string } | null;
};

export type IpcEvent = {
  protocolVersion: 1;
  kind: "event";
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
};

export type IpcMessage = IpcRequest | IpcResponse | IpcEvent;

const envelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("request"),
    requestId: z.string().min(1),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown())
  }),
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("response"),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown(),
    error: z.object({ code: z.string(), message: z.string() }).nullable()
  }),
  z.object({
    protocolVersion: z.number(),
    kind: z.literal("event"),
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1),
    payload: z.record(z.string(), z.unknown())
  })
]);

export function parseIpcMessage(value: unknown): IpcMessage {
  const parsed = envelopeSchema.parse(value);
  if (parsed.protocolVersion !== IPC_PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version: ${parsed.protocolVersion}`);
  }
  return parsed as IpcMessage;
}
