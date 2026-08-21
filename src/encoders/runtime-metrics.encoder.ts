import { NodeRuntimeMetrics } from "../interfaces/index.js";

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

export type EncodedNodeRuntimeMetrics = {
  [K in keyof NodeRuntimeMetrics as K extends keyof typeof RUNTIME_METRICS_KEY_MAP
    ? (typeof RUNTIME_METRICS_KEY_MAP)[K]
    : never]: NodeRuntimeMetrics[K];
} & {
  c?: {
    [K in keyof NodeRuntimeMetrics["cpu"] as K extends keyof typeof CPU_KEY_MAP
      ? (typeof CPU_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics["cpu"][K];
  };
  m?: {
    [K in keyof NodeRuntimeMetrics["memory"] as K extends keyof typeof MEMORY_KEY_MAP
      ? (typeof MEMORY_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics["memory"][K];
  };
  g?: {
    [K in keyof NodeRuntimeMetrics["gc"] as K extends keyof typeof GC_KEY_MAP
      ? (typeof GC_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics["gc"][K];
  } & {
    b?: {
      [K in keyof NodeRuntimeMetrics["gc"]["breakdown"] as K extends keyof typeof GC_BREAKDOWN_KEY_MAP
        ? (typeof GC_BREAKDOWN_KEY_MAP)[K]
        : never]: NodeRuntimeMetrics["gc"]["breakdown"][K];
    };
  };
  e?: {
    [K in keyof NodeRuntimeMetrics["eventLoop"] as K extends keyof typeof EVENT_LOOP_KEY_MAP
      ? (typeof EVENT_LOOP_KEY_MAP)[K]
      : never]: NodeRuntimeMetrics["eventLoop"][K];
  };
};

export class RuntimeMetricsEncoder {
  static encode(metrics: NodeRuntimeMetrics): EncodedNodeRuntimeMetrics {
    const encoded: EncodedNodeRuntimeMetrics = {} as EncodedNodeRuntimeMetrics;

    for (const key in metrics) {
      if (RUNTIME_METRICS_KEY_MAP[key as keyof NodeRuntimeMetrics]) {
        encoded[
          RUNTIME_METRICS_KEY_MAP[key as keyof NodeRuntimeMetrics] as string
        ] = metrics[key];
      }
    }

    if (metrics.cpu) {
      encoded.c = {} as EncodedNodeRuntimeMetrics["c"];
      for (const key in metrics.cpu) {
        const cpuKey = CPU_KEY_MAP[key as keyof NodeRuntimeMetrics["cpu"]];
        if (cpuKey) {
          encoded.c[cpuKey as string] =
            metrics.cpu[key as keyof NodeRuntimeMetrics["cpu"]];
        }
      }
    }

    if (metrics.memory) {
      encoded.m = {} as EncodedNodeRuntimeMetrics["m"];
      for (const key in metrics.memory) {
        const memoryKey =
          MEMORY_KEY_MAP[key as keyof NodeRuntimeMetrics["memory"]];
        if (memoryKey) {
          encoded.m[memoryKey as string] =
            metrics.memory[key as keyof NodeRuntimeMetrics["memory"]];
        }
      }
    }

    if (metrics.gc) {
      encoded.g = {} as EncodedNodeRuntimeMetrics["g"];
      for (const key in metrics.gc) {
        if (GC_KEY_MAP[key as keyof NodeRuntimeMetrics["gc"]]) {
          encoded.g[GC_KEY_MAP[key as keyof NodeRuntimeMetrics["gc"]]] =
            metrics.gc[key];
        }
      }

      if (metrics.gc.breakdown) {
        encoded.g.b = {} as EncodedNodeRuntimeMetrics["g"]["b"];
        for (const key in metrics.gc.breakdown) {
          if (
            GC_BREAKDOWN_KEY_MAP[
              key as keyof NodeRuntimeMetrics["gc"]["breakdown"]
            ]
          ) {
            encoded.g.b[
              GC_BREAKDOWN_KEY_MAP[
                key as keyof NodeRuntimeMetrics["gc"]["breakdown"]
              ]
            ] = metrics.gc.breakdown[key];
          }
        }
      }
    }

    if (metrics.eventLoop) {
      encoded.e = {} as EncodedNodeRuntimeMetrics["e"];
      for (const key in metrics.eventLoop) {
        if (EVENT_LOOP_KEY_MAP[key as keyof NodeRuntimeMetrics["eventLoop"]]) {
          encoded.e[
            EVENT_LOOP_KEY_MAP[key as keyof NodeRuntimeMetrics["eventLoop"]]
          ] = metrics.eventLoop[key];
        }
      }
    }

    return encoded;
  }
}
