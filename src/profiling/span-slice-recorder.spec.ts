import { SpanSliceRecorder } from "./span-slice-recorder.js";

describe("SpanSliceRecorder", () => {
  let recorder: SpanSliceRecorder;

  beforeEach(() => {
    recorder = new SpanSliceRecorder();
  });

  it("records a span's execution as one slice", () => {
    recorder.enter("t", "a", 0);
    recorder.exit("a", 10);

    expect(recorder.drain(10)).toEqual([
      { spanId: "a", traceId: "t", from: 0, to: 10 },
    ]);
  });

  it("gives nested work to the inner span and the rest to the outer", () => {
    recorder.enter("t", "outer", 0);
    recorder.enter("t", "inner", 10);
    recorder.exit("inner", 20);
    recorder.exit("outer", 30);

    // The intervals partition the time rather than overlapping: attributing
    // 10-20 to both would count the same microseconds twice, and a flame graph
    // built from that misstates every proportion on it.
    expect(recorder.drain(30)).toEqual([
      { spanId: "outer", traceId: "t", from: 0, to: 10 },
      { spanId: "inner", traceId: "t", from: 10, to: 20 },
      { spanId: "outer", traceId: "t", from: 20, to: 30 },
    ]);
  });

  it("produces disjoint slices for interleaved spans", () => {
    // Two requests taking turns on one thread. Their *durations* overlap; their
    // execution does not, which is the whole basis for tagging by timestamp.
    recorder.enter("t1", "a", 0);
    recorder.exit("a", 10);
    recorder.enter("t2", "b", 10);
    recorder.exit("b", 20);

    const slices = recorder.drain(20);

    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i].from).toBeGreaterThanOrEqual(slices[i - 1].to);
    }
  });

  it("closes children abandoned by a parent that ended first", () => {
    // The registry warns about un-awaited async work; leaving the child open
    // would attribute the rest of the process's time to a finished span.
    recorder.enter("t", "outer", 0);
    recorder.enter("t", "inner", 5);
    recorder.exit("outer", 20);

    const slices = recorder.drain(30);

    expect(slices.every((slice) => slice.to <= 20)).toBe(true);
    expect(slices.map((slice) => slice.spanId).sort()).toEqual([
      "inner",
      "outer",
    ]);
  });

  it("closes spans still running when the window flushes", () => {
    // A request in flight at flush time has done real work; discarding it would
    // lose exactly the long spans most worth profiling.
    recorder.enter("t", "long", 0);

    expect(recorder.drain(50)).toEqual([
      { spanId: "long", traceId: "t", from: 0, to: 50 },
    ]);
  });

  it("resumes an open span from the flush rather than its original entry", () => {
    recorder.enter("t", "long", 0);
    recorder.drain(50);

    // The second window must not re-report the first window's time.
    expect(recorder.drain(80)).toEqual([
      { spanId: "long", traceId: "t", from: 50, to: 80 },
    ]);
  });

  it("empties itself on drain", () => {
    recorder.enter("t", "a", 0);
    recorder.exit("a", 10);
    recorder.drain(10);

    expect(recorder.drain(20)).toEqual([]);
  });

  it("returns slices oldest first", () => {
    recorder.enter("t", "a", 0);
    recorder.exit("a", 5);
    recorder.enter("t", "b", 5);
    recorder.exit("b", 9);

    const slices = recorder.drain(9);

    // The join binary-searches these, which requires the order.
    expect(slices.map((slice) => slice.from)).toEqual([0, 5]);
  });

  it("discards zero-width slices", () => {
    // Decorator-heavy code opens and closes spans within the same tick; a slice
    // with no duration cannot contain a sample and would only fill the ring.
    recorder.enter("t", "a", 10);
    recorder.exit("a", 10);

    expect(recorder.drain(10)).toEqual([]);
  });

  it("ignores an exit for a span it never saw", () => {
    // Instrumentation enabled mid-request, or a span whose entry was dropped
    // when the ring wrapped.
    expect(() => recorder.exit("unknown", 10)).not.toThrow();
    expect(recorder.drain(10)).toEqual([]);
  });

  it("forgets everything on reset", () => {
    recorder.enter("t", "a", 0);
    recorder.reset();

    expect(recorder.drain(10)).toEqual([]);
  });

  it("stays bounded under sustained load", () => {
    // A busy service opens thousands of spans per window; the recorder is a
    // ring so that profiling cannot become the memory leak.
    for (let i = 0; i < 50_000; i += 1) {
      recorder.enter("t", `span-${i}`, i);
      recorder.exit(`span-${i}`, i + 0.5);
    }

    expect(recorder.drain(60_000).length).toBeLessThanOrEqual(20_000);
  });
});
