import { JobSnapshot } from "../interfaces/index.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import {
  RecursiveEncodedTrace,
  TRACE_KEY_MAP,
} from "./request-snapshot.encoder.js";

const SNAPSHOT_KEY_MAP = {
  id: "i",
  traceId: "ti",
  name: "n",
  queueName: "q",
  status: "s",
  calledAt: "c",
  startTimestamp: "st",
  duration: "d",
  enqueuedAt: "ea",
  waitDuration: "wd",
  attemptsMade: "am",
  maxAttempts: "ma",
  tags: "tg",
  traces: "t",
  error: "e",
} as const satisfies Record<keyof JobSnapshot, string>;

export type EncodedJobSnapshot = {
  [K in keyof JobSnapshot as K extends keyof typeof SNAPSHOT_KEY_MAP
    ? (typeof SNAPSHOT_KEY_MAP)[K]
    : never]: JobSnapshot[K];
} & {
  t?: Array<RecursiveEncodedTrace>;
};

export class JobSnapshotEncoder {
  static encode(snapshot: JobSnapshot): EncodedJobSnapshot {
    const encoded: EncodedJobSnapshot = {} as EncodedJobSnapshot;
    for (const key in snapshot) {
      if (SNAPSHOT_KEY_MAP[key as keyof JobSnapshot]) {
        encoded[SNAPSHOT_KEY_MAP[key as keyof JobSnapshot] as string] =
          snapshot[key];
      }
    }
    if (snapshot.traces) {
      encoded[SNAPSHOT_KEY_MAP["traces"] as string] = snapshot.traces.map(
        (trace) => this.encodeTrace(trace as CompleteTraceEventNode),
      );
    }
    return encoded;
  }

  private static encodeTrace(
    trace: CompleteTraceEventNode,
  ): EncodedJobSnapshot["t"][number] {
    const encoded: EncodedJobSnapshot["t"][number] =
      {} as EncodedJobSnapshot["t"][number];
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
