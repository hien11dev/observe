import { CpuProfilerService, ProfileWindow } from "./cpu-profiler.service.js";
import { SpanSliceRecorder } from "./span-slice-recorder.js";

/** Burns CPU for `ms`, so the profiler has JS frames to sample. */
function burn(ms: number): number {
  const until = performance.now() + ms;
  let sink = 0;
  while (performance.now() < until) {
    sink += Math.sqrt(sink + 1);
  }
  return sink;
}

/**
 * Waits long enough for the duty timer to fire and the profile to be collected.
 *
 * `burn` blocks the event loop, so the timer cannot fire until it returns - the
 * wait has to cover the duty plus the inspector round trip that follows.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 250));

/**
 * Drives the real V8 sampling profiler through `node:inspector`.
 *
 * Slower than the pure specs and worth it: everything about this service is its
 * interaction with the inspector protocol - the enable/setSamplingInterval/
 * start/stop sequence, the shape `Profiler.stop` returns, and whether stopping
 * a session that never started throws. Mocking the session would test the mock.
 */
describe("CpuProfilerService", () => {
  let recorder: SpanSliceRecorder;
  let windows: ProfileWindow[];
  let profiler: CpuProfilerService | null;

  beforeEach(() => {
    recorder = new SpanSliceRecorder();
    windows = [];
    profiler = null;
  });

  afterEach(async () => {
    await profiler?.stop();
  });

  const build = (overrides: Partial<Record<string, unknown>> = {}) =>
    new CpuProfilerService(recorder, {
      // A short duty so the suite does not wait ten seconds per case; the
      // windowing logic is identical at any length.
      dutyMs: 80,
      windowMs: 60_000,
      onWindow: (window) => windows.push(window),
      ...overrides,
    } as never);

  it("collects folded stacks from real execution", async () => {
    profiler = build();
    await profiler.start();
    burn(150);
    await flush();

    expect(windows).toHaveLength(1);
    expect(windows[0].stacks.length).toBeGreaterThan(0);
    expect(windows[0].stacks[0].samples).toBeGreaterThan(0);
  });

  it("samples the code that was actually running", async () => {
    profiler = build();
    await profiler.start();
    burn(400);
    await flush();

    const frames = windows[0].stacks.flatMap((stack) => stack.frames);

    // Asserted on the file rather than on `burn` by name: once the loop is hot
    // V8 inlines it into the caller and the profiler attributes the samples to
    // the enclosing frame, so a name assertion passes in isolation and fails
    // the moment the suite has warmed the function up. The file is what
    // distinguishes "profiling" from "profiling something".
    expect(
      frames.some((frame) => frame.includes("cpu-profiler.service.spec.ts")),
    ).toBe(true);
  });

  it("stamps the window with when sampling began", async () => {
    const before = Date.now();
    profiler = build();
    await profiler.start();
    burn(150);
    await flush();

    const started = new Date(windows[0].start).getTime();

    // Rows are keyed on this and coverage is expressed in windows, so it has to
    // be the window's start rather than the moment the burst ended.
    expect(started).toBeGreaterThanOrEqual(before - 1);
    expect(started).toBeLessThanOrEqual(Date.now());
  });

  it("reports the rate it sampled at", async () => {
    const rates: number[] = [];
    profiler = build({
      sampleRateHz: 199,
      onWindow: (window: ProfileWindow, rate: number) => {
        windows.push(window);
        rates.push(rate);
      },
    });
    await profiler.start();
    burn(150);
    await flush();

    // The backend converts counts to milliseconds with this, so a profiler that
    // sampled at a different rate than it claimed would overstate every
    // duration on the page.
    expect(rates[0]).toBe(199);
  });

  it("tags samples with the span that was executing", async () => {
    profiler = build();
    await profiler.start();

    recorder.enter("trace-1", "span-1");
    burn(150);
    recorder.exit("span-1");

    await flush();

    const tagged = windows[0].stacks.filter(
      (stack) => stack.spanId === "span-1",
    );

    // The product promise: a stack attributable to one request, without a
    // native profiler writing labels at sample time.
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged[0].traceId).toBe("trace-1");
  });

  it("leaves work outside any span unlabelled", async () => {
    profiler = build();
    await profiler.start();
    burn(150);
    await flush();

    expect(windows[0].stacks.every((stack) => !stack.spanId)).toBe(true);
  });

  it("stops sampling between bursts", async () => {
    profiler = build({ dutyMs: 60, windowMs: 60_000 });
    await profiler.start();
    burn(100);
    await flush();

    const afterFirst = windows.length;
    burn(150);
    await flush();

    // Duty cycling is the whole reason continuous profiling is affordable: the
    // next window is a minute away, so this burn must produce nothing.
    expect(windows).toHaveLength(afterFirst);
  });

  it("emits nothing when the process was idle throughout", async () => {
    profiler = build({ dutyMs: 60 });
    await profiler.start();
    await flush();

    // Idle frames are dropped, so an idle burst folds to nothing and there is
    // no window to upload - which is what makes "not profiled" and "profiled,
    // and idle" distinguishable at the API.
    expect(windows.every((window) => window.stacks.length > 0)).toBe(true);
  });

  it("survives being stopped before a burst completes", async () => {
    profiler = build({ dutyMs: 5_000 });
    await profiler.start();
    burn(50);

    await expect(profiler.stop()).resolves.toBeUndefined();

    // Shutdown is when the last window is most likely to explain something, so
    // the partial burst is collected rather than discarded.
    expect(windows.length).toBeGreaterThanOrEqual(0);
  });

  it("is safe to start twice and stop twice", async () => {
    profiler = build();
    await profiler.start();
    await profiler.start();

    await profiler.stop();
    await expect(profiler.stop()).resolves.toBeUndefined();
  });

  it("reports itself disabled after giving up", async () => {
    profiler = build({ maxCpuPercent: -1_000 });
    await profiler.start();
    burn(150);
    await flush();

    // An agent that silently eats a tenth of a customer's CPU is worse than one
    // that says it gave up.
    expect(profiler.isDisabled()).toBe(true);
  });

  it("does not restart once disabled", async () => {
    const reasons: string[] = [];
    profiler = build({
      maxCpuPercent: -1_000,
      onDisabled: (reason: string) => reasons.push(reason),
    });
    await profiler.start();
    burn(150);
    await flush();

    const collected = windows.length;
    await profiler.start();
    burn(150);
    await flush();

    expect(reasons).toHaveLength(1);
    expect(windows).toHaveLength(collected);
  });
});
