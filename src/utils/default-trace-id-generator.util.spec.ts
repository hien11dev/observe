import { defaultTraceIdGenerator } from "./default-trace-id-generator.util.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("defaultTraceIdGenerator", () => {
  it("adopts an inbound x-request-id", () => {
    // Reusing the id the caller already assigned is what lets a trace be
    // followed across services rather than restarting at each hop.
    expect(
      defaultTraceIdGenerator({ headers: { "x-request-id": "upstream-1" } }),
    ).toBe("upstream-1");
  });

  it("generates a UUID when the header is absent", () => {
    expect(defaultTraceIdGenerator({ headers: {} })).toMatch(UUID);
  });

  it("generates a UUID for a request-like object with no headers", () => {
    expect(defaultTraceIdGenerator({})).toMatch(UUID);
  });

  it("generates a UUID for anything that is not a request", () => {
    // The generator also runs for jobs and RPC messages, which carry no headers
    // at all - it must never return undefined.
    for (const input of [undefined, null, "string", 42]) {
      expect(defaultTraceIdGenerator(input)).toMatch(UUID);
    }
  });

  it("does not repeat itself", () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => defaultTraceIdGenerator({})),
    );

    // A collision would merge two unrelated traces into one.
    expect(ids.size).toBe(500);
  });
});
