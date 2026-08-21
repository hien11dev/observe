import { CustomMetric } from "../interfaces/index.js";

const CUSTOM_METRICS_KEY_MAP = {
  name: "n",
  type: "t",
  value: "v",
  tags: "tg",
  description: "d",
  labels: "l",
  lastUpdated: "lu",
  kind: "k",
  increase: "iv",
  p50: "q50",
  p95: "q95",
  p99: "q99",
  observations: "ct",
  total: "sm",
  maximum: "mx",
} as const satisfies Record<keyof CustomMetric, string>;

/**
 * Summary fields that live on the prototype as getters, in the order they are
 * copied across. `value` is deliberately absent: it is the median again, which
 * the backend derives from `q50` rather than carrying twice.
 */
const SUMMARY_KEYS = [
  "p50",
  "p95",
  "p99",
  "observations",
  "total",
  "maximum",
] as const satisfies ReadonlyArray<keyof CustomMetric>;

export type EncodedCustomMetric = {
  [K in keyof CustomMetric as K extends keyof typeof CUSTOM_METRICS_KEY_MAP
    ? (typeof CUSTOM_METRICS_KEY_MAP)[K]
    : never]: CustomMetric[K];
};

export class CustomMetricsEncoder {
  static encode(metric: CustomMetric): EncodedCustomMetric {
    const encoded: EncodedCustomMetric = {} as EncodedCustomMetric;

    for (const key in metric) {
      if (CUSTOM_METRICS_KEY_MAP[key as keyof CustomMetric]) {
        encoded[CUSTOM_METRICS_KEY_MAP[key as keyof CustomMetric] as string] =
          metric[key];
      }
    }

    // `tags` and `lastUpdated` are class getters on every metric class, and
    // getters live on the prototype where for...in cannot see them, so they
    // have to be copied across explicitly - same for the per-type getters
    // below. (Plain-object metrics carry them as own properties and are
    // already handled by the loop above; the assignments repeat harmlessly.)
    if (metric.tags) {
      encoded[CUSTOM_METRICS_KEY_MAP["tags"] as string] = metric.tags;
    }
    if (metric.lastUpdated !== undefined) {
      encoded[CUSTOM_METRICS_KEY_MAP["lastUpdated"] as string] =
        metric.lastUpdated;
    }

    if (metric.type === "counter" && metric.increase) {
      encoded[CUSTOM_METRICS_KEY_MAP["increase"] as string] = metric.increase;
    }

    // A summary's whole payload is getters, for the same reason. An empty map
    // means the window was flushed and nothing has been observed since, which is
    // not worth a row - leave the key off entirely rather than reporting a
    // distribution that does not exist.
    if (metric.type === "summary") {
      for (const key of SUMMARY_KEYS) {
        const value = metric[key];
        if (value && Object.keys(value).length > 0) {
          encoded[CUSTOM_METRICS_KEY_MAP[key] as string] = value;
        }
      }
    }

    return encoded;
  }
}
