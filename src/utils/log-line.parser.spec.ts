import { parseLogLine, stripAnsi } from "./log-line.parser.js";

/**
 * Anything that writes to stdout ends up in this path, so the parser has to cope
 * with three shapes at once: Nest's JSON logger, its text logger, and lines that
 * are neither. The governing rule is that nothing is dropped for being
 * unparseable - a log the agent does not understand is still the log someone is
 * looking for.
 */
describe("parseLogLine", () => {
  describe("structured JSON lines", () => {
    it("maps the modelled fields", () => {
      const parsed = parseLogLine(
        JSON.stringify({
          level: "warn",
          message: "disk almost full",
          context: "HealthService",
          traceId: "trace-1",
        }),
      );

      expect(parsed).toMatchObject({
        level: "warn",
        message: "disk almost full",
        context: "HealthService",
        traceId: "trace-1",
      });
    });

    it("keeps unmodelled keys as attributes", () => {
      const parsed = parseLogLine(
        JSON.stringify({
          level: "info",
          message: "order placed",
          orderId: "o-1",
          amount: 42,
        }),
      );

      expect(parsed.attributes).toMatchObject({ orderId: "o-1", amount: 42 });
      // Fields that have their own column must not be duplicated into the blob.
      expect(parsed.attributes).not.toHaveProperty("message");
      expect(parsed.attributes).not.toHaveProperty("level");
    });

    it("accepts common structured log aliases used by OTel/OpenObserve pipelines", () => {
      const parsed = parseLogLine(
        JSON.stringify({
          severity_text: "WARN",
          msg: "disk almost full",
          trace_id: "trace-1",
          span_id: "span-1",
          _timestamp: "2026-09-04T06:00:00.000Z",
        }),
      );

      expect(parsed).toMatchObject({
        level: "warn",
        message: "disk almost full",
        traceId: "trace-1",
        spanId: "span-1",
        timestamp: Date.parse("2026-09-04T06:00:00.000Z"),
      });
    });

    it("does not treat arbitrary JSON as a log record", () => {
      const line = JSON.stringify([1, 2, 3]);

      expect(parseLogLine(line).message).toBe(line);
    });

    it("falls back to the raw line for malformed JSON", () => {
      const line = '{"level":"info","message":';

      expect(parseLogLine(line).message).toBe(line);
    });
  });

  describe("Nest text lines", () => {
    it("extracts level, context and message", () => {
      const parsed = parseLogLine(
        "[Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG [AppController] handling request",
      );

      // The level is normalised to lower case, matching the LogLevel the
      // ingestion DTO accepts.
      expect(parsed).toMatchObject({
        level: "log",
        context: "AppController",
        message: "handling request",
      });
    });

    it("copes with a line that has no context bracket", () => {
      // `logger.log()` without a context omits it entirely.
      const parsed = parseLogLine(
        "[Nest] 1234  - 07/29/2026, 10:42:18 AM     WARN something happened",
      );

      expect(parsed.level).toBe("warn");
      expect(parsed.message).toBe("something happened");
      expect(parsed.context).toBeUndefined();
    });

    it.each([
      ["FATAL", "fatal"],
      ["ERROR", "error"],
      ["WARN", "warn"],
      ["LOG", "log"],
      ["DEBUG", "debug"],
      ["VERBOSE", "verbose"],
    ])("recognises %s and normalises it to %s", (printed, normalised) => {
      const parsed = parseLogLine(
        `[Nest] 1  - 07/29/2026, 10:42:18 AM     ${printed} [Ctx] message`,
      );

      expect(parsed.level).toBe(normalised);
    });

    it("keeps a multi-line message intact", () => {
      const parsed = parseLogLine(
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     ERROR [Ctx] failed\n  at foo\n  at bar",
      );

      // A stack trace is the most valuable part of an error line; truncating at
      // the first newline would discard it.
      expect(parsed.message).toContain("at foo");
      expect(parsed.message).toContain("at bar");
    });

    it("recovers a trace id appended as a suffix", () => {
      const parsed = parseLogLine(
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: abc-123",
      );

      // The async context may be gone by the time the forwarder sees the line,
      // so the suffix is how the trace survives.
      expect(parsed.traceId).toBe("abc-123");
      expect(parsed.message).not.toContain("Trace ID");
    });
  });

  describe("unrecognised lines", () => {
    it.each([
      "plain stdout output",
      "  ",
      "npm warn deprecated package@1.0.0",
      "> observe-api@1.0.0 start",
    ])("forwards %s with its full text as the message", (line) => {
      expect(parseLogLine(line).message).toBe(line.trimEnd());
    });

    it("never returns undefined for the message", () => {
      for (const line of ["", "{}", "[]", "null", "[Nest]"]) {
        expect(typeof parseLogLine(line).message).toBe("string");
      }
    });
  });

  describe("ANSI handling", () => {
    it("strips colour codes", () => {
      expect(stripAnsi("[32mgreen[39m")).toBe("green");
    });

    it("removes colour before parsing", () => {
      const parsed = parseLogLine(
        "[32m[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG[39m [Ctx] coloured",
      );

      expect(parsed.level).toBe("log");
      expect(parsed.message).toBe("coloured");
    });

    it("leaves ordinary text alone", () => {
      // A tighter pattern than a general ANSI stripper, so it cannot eat real
      // log content that happens to contain brackets.
      expect(stripAnsi("array[0] and cost[USD]")).toBe(
        "array[0] and cost[USD]",
      );
    });
  });
});
