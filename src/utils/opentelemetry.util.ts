import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";

export const OTEL_BAGGAGE_KEY = "#otel.baggage";
export const OTEL_TRACE_FLAGS_KEY = "#otel.trace_flags";

type AttributeValue = string | number | boolean;

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  traceFlags: string;
  raw: string;
}

const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.+)?$/i;
const HEX_32 = /^[0-9a-f]{32}$/i;
const HEX_16 = /^[0-9a-f]{16}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseTraceparent(value: unknown): ParsedTraceparent | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, version, traceId, parentSpanId, traceFlags] = match;
  const parts = value.trim().split("-");
  if (
    version.toLowerCase() === "ff" ||
    (version.toLowerCase() === "00" && parts.length !== 4) ||
    (version.toLowerCase() !== "00" &&
      (parts.length < 5 || parts.slice(4).some((part) => part.length === 0))) ||
    traceId === "00000000000000000000000000000000" ||
    parentSpanId === "0000000000000000"
  ) {
    return undefined;
  }
  return {
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    traceFlags: traceFlags.toLowerCase(),
    raw: `${version.toLowerCase()}-${traceId.toLowerCase()}-${parentSpanId.toLowerCase()}-${traceFlags.toLowerCase()}`,
  };
}

export function parseBaggage(
  value: unknown,
): Record<string, string> | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const baggage: Record<string, string> = {};
  for (const member of value.split(",")) {
    const [entry] = member.split(";", 1);
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const rawValue = entry.slice(separator + 1).trim();
    if (!key || !rawValue) {
      continue;
    }
    try {
      baggage[key] = decodeURIComponent(rawValue);
    } catch {
      baggage[key] = rawValue;
    }
  }
  return Object.keys(baggage).length > 0 ? baggage : undefined;
}

export function baggageToHeader(
  baggage: Record<string, string> | undefined,
): string | undefined {
  if (!baggage || Object.keys(baggage).length === 0) {
    return undefined;
  }
  return Object.entries(baggage)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(",");
}

export function normalizeTraceIdForTraceparent(
  traceId: string | undefined,
): string | undefined {
  if (!traceId) {
    return undefined;
  }
  if (HEX_32.test(traceId)) {
    return traceId === "00000000000000000000000000000000"
      ? undefined
      : traceId.toLowerCase();
  }
  if (UUID.test(traceId)) {
    const normalized = traceId.replaceAll("-", "").toLowerCase();
    return normalized === "00000000000000000000000000000000"
      ? undefined
      : normalized;
  }
  return undefined;
}

export function normalizeSpanIdForTraceparent(
  spanId: string | undefined,
): string | undefined {
  if (!spanId) {
    return undefined;
  }
  if (HEX_16.test(spanId)) {
    return spanId.toLowerCase();
  }
  if (UUID.test(spanId)) {
    const normalized = spanId.replaceAll("-", "").slice(16).toLowerCase();
    return normalized === "0000000000000000" ? undefined : normalized;
  }
  return undefined;
}

export function formatTraceparent(
  traceId: string | undefined,
  spanId: string | undefined,
  traceFlags = "01",
): string | undefined {
  const normalizedTraceId = normalizeTraceIdForTraceparent(traceId);
  const normalizedSpanId = normalizeSpanIdForTraceparent(spanId);
  const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
  return normalizedTraceId && normalizedSpanId
    ? `00-${normalizedTraceId}-${normalizedSpanId}-${normalizedTraceFlags}`
    : undefined;
}

export function extractPropagation(source: unknown): {
  traceparent?: ParsedTraceparent;
  baggage?: Record<string, string>;
} {
  let traceparent: ParsedTraceparent | undefined;
  let baggage: Record<string, string> | undefined;

  for (const carrier of carriersFrom(source)) {
    traceparent ??= parseTraceparent(readCarrierValue(carrier, "traceparent"));
    baggage ??= parseBaggage(readCarrierValue(carrier, "baggage"));
    if (traceparent && baggage) {
      break;
    }
  }

  return { traceparent, baggage };
}

export function toBaggageTags(
  baggage: Record<string, string> | undefined,
): Record<string, string> {
  if (!baggage) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(baggage).map(([key, value]) => [`baggage.${key}`, value]),
  );
}

export function getOpenTelemetryResourceAttributes(
  options: ObserveModuleOptionsWithDefaults,
): Record<string, AttributeValue> {
  const resource: Record<string, AttributeValue> = {
    "service.name":
      options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? options.serviceId,
    "service.instance.id": options.serviceId,
  };

  const serviceVersion =
    options.serviceVersion ?? process.env.OTEL_SERVICE_VERSION;
  if (serviceVersion) {
    resource["service.version"] = serviceVersion;
  }

  const deploymentEnvironment =
    options.deploymentEnvironment ??
    process.env.OTEL_DEPLOYMENT_ENVIRONMENT ??
    process.env.NODE_ENV;
  if (deploymentEnvironment) {
    resource["deployment.environment"] = deploymentEnvironment;
  }

  return {
    ...resource,
    ...options.resourceAttributes,
  };
}

function carriersFrom(
  source: unknown,
  seen: WeakSet<object> = new WeakSet(),
): object[] {
  if (!source || typeof source !== "object") {
    return [];
  }
  if (seen.has(source)) {
    return [];
  }
  seen.add(source);
  const carriers: object[] = [source];
  const candidate = source as {
    headers?: unknown;
    metadata?: unknown;
    getArgs?: () => unknown[];
  };
  if (candidate.headers) {
    carriers.push(candidate.headers);
  }
  if (candidate.metadata) {
    carriers.push(candidate.metadata);
  }
  if (typeof candidate.getArgs === "function") {
    for (const item of candidate.getArgs().filter(
      (entry): entry is object => Boolean(entry) && typeof entry === "object",
    )) {
      carriers.push(item, ...carriersFrom(item, seen));
    }
  }
  return carriers;
}

function readCarrierValue(carrier: unknown, key: string): string | undefined {
  if (!carrier || typeof carrier !== "object") {
    return undefined;
  }
  const value = readValue(carrier as Record<string, unknown>, key);
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  const accessorCarrier = carrier as {
    get?: (name: string) => unknown;
    getMap?: () => Record<string, unknown>;
  };
  if (typeof accessorCarrier.get === "function") {
    const accessed = accessorCarrier.get(key);
    if (typeof accessed === "string") {
      return accessed;
    }
    if (Array.isArray(accessed) && typeof accessed[0] === "string") {
      return accessed[0];
    }
  }
  if (typeof accessorCarrier.getMap === "function") {
    const map = accessorCarrier.getMap();
    const mapped = readValue(map, key);
    if (typeof mapped === "string") {
      return mapped;
    }
    if (Array.isArray(mapped) && typeof mapped[0] === "string") {
      return mapped[0];
    }
  }
  return undefined;
}

function readValue(
  carrier: Record<string, unknown>,
  key: string,
): unknown | undefined {
  if (key in carrier) {
    return carrier[key];
  }
  const match = Object.entries(carrier).find(
    ([candidate]) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return match?.[1];
}

function normalizeTraceFlags(traceFlags: string): string {
  return /^[0-9a-f]{2}$/i.test(traceFlags) && traceFlags.toLowerCase() !== "ff"
    ? traceFlags.toLowerCase()
    : "00";
}
