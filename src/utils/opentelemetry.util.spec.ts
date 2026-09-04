import {
  baggageToHeader,
  extractPropagation,
  formatTraceparent,
  normalizeSpanIdForTraceparent,
  parseBaggage,
  parseTraceparent,
} from "./opentelemetry.util.js";

describe("OpenTelemetry helpers", () => {
  describe("parseTraceparent", () => {
    it("rejects version 00 headers with extra members", () => {
      expect(
        parseTraceparent(
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
        ),
      ).toBeUndefined();
    });

    it("accepts a valid W3C header", () => {
      expect(
        parseTraceparent(
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        ),
      ).toMatchObject({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        traceFlags: "01",
      });
    });
  });

  describe("formatTraceparent", () => {
    it("falls back to an unsampled flag when the stored one is invalid", () => {
      expect(
        formatTraceparent(
          "123e4567-e89b-12d3-a456-426614174000",
          "123e4567-e89b-12d3-a456-426614174999",
          "zz",
        ),
      ).toBe(
        "00-123e4567e89b12d3a456426614174000-a456426614174999-00",
      );
    });

    it("drops UUID-derived parent ids that normalize to all zeros", () => {
      expect(
        normalizeSpanIdForTraceparent(
          "123e4567-e89b-12d3-0000-000000000000",
        ),
      ).toBeUndefined();
    });
  });

  describe("baggage helpers", () => {
    it("parses W3C baggage members", () => {
      expect(parseBaggage("tenant=acme,user=alice%40example.com")).toEqual({
        tenant: "acme",
        user: "alice@example.com",
      });
    });

    it("serializes baggage for downstream propagation", () => {
      expect(
        baggageToHeader({
          tenant: "acme",
          user: "alice@example.com",
        }),
      ).toBe("tenant=acme,user=alice%40example.com");
    });

    it("extracts trace context and baggage from mixed carrier shapes", () => {
      expect(
        extractPropagation({
          getArgs: () => [
            {
              headers: {
                traceparent:
                  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
                baggage: "tenant=acme",
              },
            },
          ],
        }),
      ).toMatchObject({
        traceparent: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "00f067aa0ba902b7",
          traceFlags: "01",
        },
        baggage: {
          tenant: "acme",
        },
      });
    });

    it("matches propagation keys case-insensitively on plain objects", () => {
      expect(
        extractPropagation({
          headers: {
            Traceparent:
              "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
            Baggage: "tenant=acme",
          },
        }),
      ).toMatchObject({
        traceparent: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        },
        baggage: {
          tenant: "acme",
        },
      });
    });

    it("does not recurse forever on cyclic carrier graphs", () => {
      const carrier: { headers?: Record<string, string>; self?: unknown } = {
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      };
      carrier.self = carrier;

      expect(() => extractPropagation({ getArgs: () => [carrier] })).not.toThrow();
    });
  });
});
