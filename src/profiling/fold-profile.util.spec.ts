import { foldProfile, V8Profile } from "./fold-profile.util.js";
import { SpanSliceRecorder } from "./span-slice-recorder.js";

/**
 * The order a bare `sort()` produces, written out because a span id is optional
 * and the default comparator is only defined for strings. `undefined` never
 * reaches here - `sort` places it last on its own - so the sorted results below
 * are unchanged.
 */
const bySpanId = (a: string | undefined, b: string | undefined): number =>
  a === b ? 0 : (a ?? "") < (b ?? "") ? -1 : 1;

/**
 * Builds a profile with the shape `Profiler.stop` returns: a node tree, one
 * node id per sample, and the microseconds elapsed before each sample.
 */
function profileOf(options: {
  nodes: Array<{
    id: number;
    name: string;
    url?: string;
    line?: number;
    children?: number[];
  }>;
  samples: number[];
  timeDeltas: number[];
}): V8Profile {
  return {
    startTime: 0,
    endTime: 1_000_000,
    samples: options.samples,
    timeDeltas: options.timeDeltas,
    nodes: options.nodes.map((node) => ({
      id: node.id,
      children: node.children,
      callFrame: {
        functionName: node.name,
        url: node.url ?? "",
        lineNumber: node.line ?? 0,
        columnNumber: 0,
      },
    })),
  };
}

/** root -> handler -> parse, the shape almost every assertion below wants. */
const threeDeep = (samples: number[], timeDeltas: number[]) =>
  profileOf({
    nodes: [
      { id: 1, name: "(root)", children: [2] },
      {
        id: 2,
        name: "handler",
        url: "file:///app/h.js",
        line: 9,
        children: [3],
      },
      { id: 3, name: "parse", url: "file:///app/p.js", line: 41 },
    ],
    samples,
    timeDeltas,
  });

describe("foldProfile", () => {
  it("resolves a sample to its root-first stack", () => {
    const folded = foldProfile(threeDeep([3], [0]), { startedAt: 0 });

    // The profile is a tree and a sample names a leaf; the stack is the walk up
    // to the root, which is the order the backend parses.
    expect(folded[0].frames).toEqual([
      "handler /app/h.js:10",
      "parse /app/p.js:42",
    ]);
  });

  it("shifts line numbers to the one-based convention humans read", () => {
    // The inspector protocol reports zero-based lines and every editor shows
    // one-based, so the agent converts rather than the backend - only this side
    // knows which convention its input used.
    const folded = foldProfile(threeDeep([2], [0]), { startedAt: 0 });

    expect(folded[0].frames[0]).toBe("handler /app/h.js:10");
  });

  it("folds repeated samples of one stack into a count", () => {
    const folded = foldProfile(threeDeep([3, 3, 3], [0, 10_101, 10_101]), {
      startedAt: 0,
    });

    expect(folded).toHaveLength(1);
    expect(folded[0].samples).toBe(3);
  });

  it("keeps distinct stacks apart", () => {
    const folded = foldProfile(threeDeep([2, 3], [0, 10_101]), {
      startedAt: 0,
    });

    expect(folded).toHaveLength(2);
  });

  it("drops the synthetic root and idle frames", () => {
    // Idle is real wall clock but no function ran; a flame graph of it answers
    // no question anyone opened the page with.
    const profile = profileOf({
      nodes: [
        { id: 1, name: "(root)", children: [2, 3] },
        { id: 2, name: "(idle)" },
        { id: 3, name: "work", url: "file:///a.js", line: 0 },
      ],
      samples: [2, 3],
      timeDeltas: [0, 10_101],
    });

    const folded = foldProfile(profile, { startedAt: 0 });

    expect(folded).toHaveLength(1);
    expect(folded[0].frames).toEqual(["work /a.js:1"]);
  });

  it("keeps garbage collection as a frame", () => {
    // GC is one of the things a profile is opened to find.
    const profile = profileOf({
      nodes: [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "(garbage collector)" },
      ],
      samples: [2],
      timeDeltas: [0],
    });

    expect(foldProfile(profile, { startedAt: 0 })[0].frames).toEqual([
      "(garbage collector)",
    ]);
  });

  it("names an unnamed function rather than dropping it", () => {
    const profile = profileOf({
      nodes: [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "", url: "file:///a.js", line: 4 },
      ],
      samples: [2],
      timeDeltas: [0],
    });

    expect(foldProfile(profile, { startedAt: 0 })[0].frames).toEqual([
      "(anonymous) /a.js:5",
    ]);
  });

  it("emits a native frame without a location", () => {
    const profile = profileOf({
      nodes: [
        { id: 1, name: "(root)", children: [2] },
        { id: 2, name: "nativeThing" },
      ],
      samples: [2],
      timeDeltas: [0],
    });

    expect(foldProfile(profile, { startedAt: 0 })[0].frames).toEqual([
      "nativeThing",
    ]);
  });

  it("returns nothing for a profile with no samples", () => {
    expect(
      foldProfile(profileOf({ nodes: [], samples: [], timeDeltas: [] }), {
        startedAt: 0,
      }),
    ).toEqual([]);
  });

  describe("span tagging", () => {
    it("labels a sample with the span executing at that instant", () => {
      // Sample one fires 10ms in, inside the slice; the join is on time, which
      // is sound because only one span's synchronous code runs at a time.
      const slices = [
        { spanId: "span-1", traceId: "trace-1", from: 5, to: 20 },
      ];

      const folded = foldProfile(threeDeep([3], [10_000]), {
        startedAt: 0,
        slices,
      });

      expect(folded[0]).toMatchObject({
        spanId: "span-1",
        traceId: "trace-1",
      });
    });

    it("leaves a sample outside every slice unlabelled", () => {
      // Code running in no span carries no span. Guessing here would produce an
      // "exact" tree that is wrong, which is worse than the window fallback.
      const slices = [
        { spanId: "span-1", traceId: "trace-1", from: 100, to: 200 },
      ];

      const folded = foldProfile(threeDeep([3], [10_000]), {
        startedAt: 0,
        slices,
      });

      expect(folded[0].spanId).toBeUndefined();
    });

    it("splits one stack into labelled and unlabelled entries", () => {
      const slices = [
        { spanId: "span-1", traceId: "trace-1", from: 0, to: 15 },
      ];

      // Two samples of the same stack, one inside the span and one after it.
      const folded = foldProfile(threeDeep([3, 3], [10_000, 20_000]), {
        startedAt: 0,
        slices,
      });

      expect(folded).toHaveLength(2);
      expect(folded.map((entry) => entry.spanId).sort(bySpanId)).toEqual([
        "span-1",
        undefined,
      ]);
    });

    it("attributes consecutive samples to the spans that were running", () => {
      const slices = [
        { spanId: "a", traceId: "t", from: 0, to: 15 },
        { spanId: "b", traceId: "t", from: 15, to: 40 },
      ];

      const folded = foldProfile(threeDeep([3, 3], [10_000, 20_000]), {
        startedAt: 0,
        slices,
      });

      // 10ms lands in a, 30ms lands in b - a concurrent server's spans overlap
      // in duration but never in execution.
      expect(folded.map((entry) => entry.spanId).sort(bySpanId)).toEqual([
        "a",
        "b",
      ]);
    });

    it("treats a slice as half-open at its end", () => {
      // Adjacent slices share a boundary; a sample exactly on it belongs to the
      // one that had just begun, or it would be counted in both.
      const slices = [
        { spanId: "a", traceId: "t", from: 0, to: 10 },
        { spanId: "b", traceId: "t", from: 10, to: 20 },
      ];

      const folded = foldProfile(threeDeep([3], [10_000]), {
        startedAt: 0,
        slices,
      });

      expect(folded[0].spanId).toBe("b");
    });

    it("maps sample times through the profiler's start", () => {
      // V8 reports microseconds on a clock with no epoch, so only offsets mean
      // anything and the caller supplies the origin.
      const slices = [{ spanId: "late", traceId: "t", from: 1_005, to: 1_020 }];

      const folded = foldProfile(threeDeep([3], [10_000]), {
        startedAt: 1_000,
        slices,
      });

      expect(folded[0].spanId).toBe("late");
    });
  });

  describe("with the recorder", () => {
    it("labels samples from slices the recorder produced", () => {
      const recorder = new SpanSliceRecorder();
      recorder.enter("trace-1", "span-1", 0);
      recorder.exit("span-1", 50);

      const folded = foldProfile(threeDeep([3], [20_000]), {
        startedAt: 0,
        slices: recorder.drain(60),
      });

      expect(folded[0].spanId).toBe("span-1");
    });

    it("attributes nested work to the innermost span", () => {
      const recorder = new SpanSliceRecorder();
      recorder.enter("trace-1", "outer", 0);
      recorder.enter("trace-1", "inner", 10);
      recorder.exit("inner", 30);
      recorder.exit("outer", 40);

      const folded = foldProfile(threeDeep([3], [20_000]), {
        startedAt: 0,
        slices: recorder.drain(50),
      });

      // 20ms is inside `inner`. Attributing it to `outer` as well would
      // double-count the same microseconds.
      expect(folded[0].spanId).toBe("inner");
    });
  });
});
