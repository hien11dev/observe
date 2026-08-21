import { NodeRuntimeMetrics } from "../interfaces/index.js";
import { remapKeys } from "./remap-keys.util.js";

const RUNTIME_METRICS_KEY_MAP = {
  cpu: "c",
  memory: "m",
  gc: "g",
  eventLoop: "e",
} as const satisfies Record<keyof NodeRuntimeMetrics, string>;

const CPU_KEY_MAP = {
  user: "u",
  system: "s",
  percentageUsed: "p",
} as const satisfies Record<keyof NodeRuntimeMetrics["cpu"], string>;

const MEMORY_KEY_MAP = {
  rss: "r",
  heapTotal: "ht",
  heapUsed: "hu",
  external: "e",
  arrayBuffers: "ab",
  percentageUsed: "p",
} as const satisfies Record<keyof NodeRuntimeMetrics["memory"], string>;

const GC_KEY_MAP = {
  count: "c",
  totalDuration: "td",
  breakdown: "b",
} as const satisfies Record<keyof NodeRuntimeMetrics["gc"], string>;

const GC_BREAKDOWN_KEY_MAP = {
  minor: "m",
  major: "j",
  incremental: "i",
} as const satisfies Record<
  keyof NodeRuntimeMetrics["gc"]["breakdown"],
  string
>;

const EVENT_LOOP_KEY_MAP = {
  lag: "l",
  utilization: "u",
} as const satisfies Record<keyof NodeRuntimeMetrics["eventLoop"], string>;

type EncodedCpu = {
  [K in keyof NodeRuntimeMetrics["cpu"] as K extends keyof typeof CPU_KEY_MAP
    ? (typeof CPU_KEY_MAP)[K]
    : never]: NodeRuntimeMetrics["cpu"][K];
};

type EncodedMemory = {
  [K in keyof NodeRuntimeMetrics["memory"] as K extends keyof typeof MEMORY_KEY_MAP
    ? (typeof MEMORY_KEY_MAP)[K]
    : never]: NodeRuntimeMetrics["memory"][K];
};

type EncodedGcBreakdown = {
  [K in keyof NonNullable<
    NodeRuntimeMetrics["gc"]["breakdown"]
  > as K extends keyof typeof GC_BREAKDOWN_KEY_MAP
    ? (typeof GC_BREAKDOWN_KEY_MAP)[K]
    : never]: NonNullable<NodeRuntimeMetrics["gc"]["breakdown"]>[K];
};

type EncodedGc = Omit<
  {
    [K in keyof NodeRuntimeMetrics["gc"] as K extends keyof typeof GC_KEY_MAP
      ? (typeof GC_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics["gc"][K];
  },
  "b"
> & {
  b?: EncodedGcBreakdown;
};

type EncodedEventLoop = {
  [K in keyof NodeRuntimeMetrics["eventLoop"] as K extends keyof typeof EVENT_LOOP_KEY_MAP
    ? (typeof EVENT_LOOP_KEY_MAP)[K]
    : never]: NodeRuntimeMetrics["eventLoop"][K];
};

// Each section holds encoded values, so the four keys are replaced rather than
// intersected - intersecting left them claiming both the long-form and the
// short-form fields at once, and only the short-form ones are ever written.
export type EncodedNodeRuntimeMetrics = Omit<
  {
    [K in keyof NodeRuntimeMetrics as K extends keyof typeof RUNTIME_METRICS_KEY_MAP
      ? (typeof RUNTIME_METRICS_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics[K];
  },
  "c" | "m" | "g" | "e"
> & {
  c?: EncodedCpu;
  m?: EncodedMemory;
  g?: EncodedGc;
  e?: EncodedEventLoop;
};

export class RuntimeMetricsEncoder {
  static encode(metrics: NodeRuntimeMetrics): EncodedNodeRuntimeMetrics {
    const encoded = remapKeys<NodeRuntimeMetrics, EncodedNodeRuntimeMetrics>(
      metrics,
      RUNTIME_METRICS_KEY_MAP,
    );

    if (metrics.cpu) {
      encoded.c = remapKeys<NodeRuntimeMetrics["cpu"], EncodedCpu>(
        metrics.cpu,
        CPU_KEY_MAP,
      );
    }

    if (metrics.memory) {
      encoded.m = remapKeys<NodeRuntimeMetrics["memory"], EncodedMemory>(
        metrics.memory,
        MEMORY_KEY_MAP,
      );
    }

    if (metrics.gc) {
      encoded.g = remapKeys<NodeRuntimeMetrics["gc"], EncodedGc>(
        metrics.gc,
        GC_KEY_MAP,
      );

      if (metrics.gc.breakdown) {
        encoded.g.b = remapKeys<
          NonNullable<NodeRuntimeMetrics["gc"]["breakdown"]>,
          EncodedGcBreakdown
        >(metrics.gc.breakdown, GC_BREAKDOWN_KEY_MAP);
      }
    }

    if (metrics.eventLoop) {
      encoded.e = remapKeys<NodeRuntimeMetrics["eventLoop"], EncodedEventLoop>(
        metrics.eventLoop,
        EVENT_LOOP_KEY_MAP,
      );
    }

    return encoded;
  }
}
