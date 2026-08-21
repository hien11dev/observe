import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";

export const TRACE_KEY_MAP = {
  name: "n",
  origin: "o",
  tags: "t",
  duration: "d",
  error: "e",
  className: "c",
  methodKey: "m",
  children: "ch",
  spanId: "s",
  startOffset: "so",
} as const satisfies Record<keyof CompleteTraceEventNode, string>;

const ATTRIBUTES_KEY_MAP = {
  method: "m",
  statusCode: "sc",
  originalUrl: "ou",
} as const satisfies Record<keyof RequestSnapshot["attributes"], string>;

const SNAPSHOT_KEY_MAP = {
  calledAt: "ct",
  traceId: "ti",
  startTimestamp: "st",
  duration: "d",
  protocol: "p",
  operationId: "op",
  traces: "t",
  attributes: "a",
  tags: "tg",
  error: "e",
  userId: "u",
} as const satisfies Record<keyof RequestSnapshot, string>;

export type RecursiveEncodedTrace = {
  [K in keyof Omit<
    CompleteTraceEventNode,
    "children"
  > as K extends keyof typeof TRACE_KEY_MAP
    ? (typeof TRACE_KEY_MAP)[K]
    : never]: CompleteTraceEventNode[K];
} & {
  ch?: Array<RecursiveEncodedTrace>;
};

export type EncodedAttributes = {
  [K in keyof RequestSnapshot["attributes"] as K extends keyof typeof ATTRIBUTES_KEY_MAP
    ? (typeof ATTRIBUTES_KEY_MAP)[K]
    : never]: RequestSnapshot["attributes"][K];
};

export type EncodedRequestSnapshot = {
  [K in keyof RequestSnapshot as K extends keyof typeof SNAPSHOT_KEY_MAP
    ? (typeof SNAPSHOT_KEY_MAP)[K]
    : never]: RequestSnapshot[K];
} & {
  t?: Array<RecursiveEncodedTrace>;
};

export class RequestSnapshotEncoder {
  static encode(snapshot: RequestSnapshot): EncodedRequestSnapshot {
    const encoded: EncodedRequestSnapshot = {} as EncodedRequestSnapshot;
    for (const key in snapshot) {
      if (SNAPSHOT_KEY_MAP[key as keyof RequestSnapshot]) {
        encoded[SNAPSHOT_KEY_MAP[key as keyof RequestSnapshot] as string] =
          snapshot[key];
      }
    }
    if (snapshot.traces) {
      encoded[SNAPSHOT_KEY_MAP["traces"] as string] = snapshot.traces.map(
        (trace) => this.encodeTrace(trace as CompleteTraceEventNode),
      );
    }
    if (snapshot.attributes) {
      encoded[SNAPSHOT_KEY_MAP["attributes"] as string] = {};
      for (const attrKey in snapshot.attributes) {
        if (
          ATTRIBUTES_KEY_MAP[attrKey as keyof RequestSnapshot["attributes"]]
        ) {
          encoded[SNAPSHOT_KEY_MAP["attributes"] as string][
            ATTRIBUTES_KEY_MAP[attrKey as keyof RequestSnapshot["attributes"]]
          ] = snapshot.attributes[attrKey];
        }
      }
    }
    return encoded;
  }

  private static encodeTrace(
    trace: CompleteTraceEventNode,
  ): EncodedRequestSnapshot["t"][number] {
    const encoded: EncodedRequestSnapshot["t"][number] =
      {} as EncodedRequestSnapshot["t"][number];
    for (const key in trace) {
      if (TRACE_KEY_MAP[key as keyof CompleteTraceEventNode]) {
        encoded[TRACE_KEY_MAP[key as keyof CompleteTraceEventNode] as string] =
          trace[key];
      }
    }
    // Outside the loop above, deliberately. Nested inside it, every own key of
    // a node re-encoded that node's whole subtree, so the work was keys^depth
    // rather than one visit per node - a trace a few levels deeper than a plain
    // HTTP request (a queued job that authenticates, submits and polls) pinned
    // the event loop and never came back.
    if (trace.children && trace.children.length > 0) {
      encoded.ch = trace.children.map((child) =>
        this.encodeTrace(child as CompleteTraceEventNode),
      ) as RecursiveEncodedTrace[];
    }
    return encoded;
  }
}
