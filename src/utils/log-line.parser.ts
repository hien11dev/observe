/**
 * Turns a line of stdout into a structured log entry.
 *
 * Two shapes arrive here and neither can be assumed: a service running Nest's
 * JSON logger emits one object per line, while the default logger emits
 * formatted text - and plenty of lines are neither, because anything that writes
 * to stdout ends up in this path. Detection is therefore per line rather than
 * per service: a line that parses as a recognisable JSON log is treated as
 * structured, everything else falls back to text parsing, and a line that
 * matches nothing is still forwarded with its full text as the message.
 *
 * Nothing is ever dropped for being unparseable. A log the agent does not
 * understand is still the log the user is looking for.
 */

export interface ParsedLogLine {
  timestamp?: number;
  level?: string;
  context?: string;
  message: string;
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, unknown>;
}
/**
 * CSI escape sequences - colour codes and cursor moves. Narrower than a
 * general-purpose ANSI stripper on purpose: this only has to undo what console
 * loggers emit, and a tight pattern cannot eat real log content.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * Nest's default ConsoleLogger line:
 *   [Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG [AppController] message
 * The context bracket is optional - `logger.log()` without a context omits it.
 */
const NEST_TEXT_PATTERN =
  /^\[Nest\]\s+\d+\s+-\s+.+?\s{2,}(FATAL|ERROR|WARN|LOG|DEBUG|VERBOSE)\s+(?:\[([^\]]+)\]\s*)?([\s\S]*)$/;

/**
 * Suffix appended by LoggerPatcherService when a trace is in scope. Parsing it
 * back off recovers the trace id even for lines whose async context is gone by
 * the time the forwarder sees them.
 */
const TRACE_ID_SUFFIX_PATTERN = /\s*Trace ID:\s*(\S+)\s*$/;

/**
 * Keys the JSON logger sets that map onto modelled columns; anything else a
 * service attaches is preserved under `attributes`.
 */
const STRUCTURED_KEYS = new Set([
  "level",
  "severity",
  "severityText",
  "severity_text",
  "message",
  "msg",
  "body",
  "context",
  "trace_id",
  "traceId",
  "span_id",
  "spanId",
  "timestamp",
  "_timestamp",
  "time",
  "ts",
  "pid",
]);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function parseLogLine(line: string): ParsedLogLine {
  const clean = stripAnsi(line).trimEnd();

  return parseStructured(clean) ?? parseNestText(clean) ?? { message: clean };
}

function parseStructured(line: string): ParsedLogLine | null {
  // Cheap guard so the common text case never pays for a thrown parse error.
  if (!line.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  // A JSON line with no message is some other program's output that happens to
  // be JSON - not a log we can model, so let the text path have it.
  if (typeof readCandidateMessage(record) !== "string") {
    return null;
  }

  const attributes = Object.fromEntries(
    Object.entries(record).filter(([key]) => !STRUCTURED_KEYS.has(key)),
  );

  return {
    timestamp: parseTimestamp(
      record.timestamp ?? record._timestamp ?? record.time ?? record.ts,
    ),
    level: readLevel(record),
    context: typeof record.context === "string" ? record.context : undefined,
    traceId: readString(record.traceId ?? record.trace_id),
    spanId: readString(record.spanId ?? record.span_id),
    message: readMessage(record),
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
  };
}

function parseNestText(line: string): ParsedLogLine | null {
  const match = NEST_TEXT_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const [, level, context, rest] = match;
  const traceIdMatch = TRACE_ID_SUFFIX_PATTERN.exec(rest);

  return {
    level: level.toLowerCase(),
    context: context || undefined,
    traceId: traceIdMatch?.[1],
    message: traceIdMatch ? rest.slice(0, traceIdMatch.index).trimEnd() : rest,
  };
}

function readMessage(record: Record<string, unknown>): string {
  const message = readCandidateMessage(record);
  return typeof message === "string" ? message : "";
}

function readCandidateMessage(record: Record<string, unknown>): unknown {
  return record.message ?? record.msg ?? record.body;
}

function readLevel(record: Record<string, unknown>): string | undefined {
  const level = record.level ?? record.severityText ?? record.severity_text;
  return typeof level === "string" ? level.toLowerCase() : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
