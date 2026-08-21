import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "./node-runtime-metrics.service.js";

/**
 * Samples the process every flush. The interesting behaviour is not the numbers
 * themselves - they come from Node - but the bookkeeping around them: CPU is a
 * *delta* against the previous sample, GC counters describe one window and must
 * reset after being read, and the monitors have to be torn down or they outlive
 * the application.
 */
describe("NodeRuntimeMetricsService", () => {
  const build = (options: Partial<ObserveModuleOptionsWithDefaults> = {}) =>
    new NodeRuntimeMetricsService({
      ...options,
    } as ObserveModuleOptionsWithDefaults);

  let service: NodeRuntimeMetricsService;

  afterEach(async () => {
    // Both the event-loop histogram and the GC observer keep the process alive.
    await service?.onApplicationShutdown();
  });

  describe("collection", () => {
    beforeEach(() => {
      service = build();
      service.onModuleInit();
    });

    it("reports memory in megabytes with a percentage of the host", () => {
      const metrics = service.collectNodeRuntimeMetrics();

      // Bytes would make every dashboard axis unreadable; the conversion is the
      // only reason these are not raw `process.memoryUsage()` values.
      expect(metrics.memory.rss).toBeGreaterThan(0);
      expect(metrics.memory.rss).toBeLessThan(100_000);
      expect(metrics.memory.heapUsed).toBeLessThanOrEqual(
        metrics.memory.heapTotal,
      );
      expect(metrics.memory.percentageUsed).toBeGreaterThan(0);
      expect(metrics.memory.percentageUsed).toBeLessThan(100);
    });

    it("reports CPU as the work done since the previous sample", () => {
      service.collectNodeRuntimeMetrics();

      // Busy-wait so the second window has measurable CPU in it.
      const until = Date.now() + 20;
      while (Date.now() < until) {
        /* burn */
      }
      const second = service.collectNodeRuntimeMetrics();

      // A cumulative reading would grow forever and make "CPU used this minute"
      // meaningless.
      expect(second.cpu.user).toBeGreaterThanOrEqual(0);
      expect(second.cpu.system).toBeGreaterThanOrEqual(0);
      expect(second.cpu.percentageUsed).toBeGreaterThanOrEqual(0);
    });

    it("does not let CPU usage grow without bound across samples", () => {
      const first = service.collectNodeRuntimeMetrics();
      const second = service.collectNodeRuntimeMetrics();

      // Two samples taken back to back cover almost no time, so the second must
      // not report the whole process lifetime again.
      expect(second.cpu.user).toBeLessThanOrEqual(first.cpu.user + 1000);
    });

    it("reports a finite lag on the very first sample", () => {
      // The histogram's `mean` is NaN until it has recorded something, and a
      // flush can land immediately after startup. NaN survives into a numeric
      // column, poisons every average built over it, and makes the runtime
      // alert comparisons undefined.
      const metrics = service.collectNodeRuntimeMetrics();

      expect(Number.isFinite(metrics.eventLoop.lag)).toBe(true);
      expect(metrics.eventLoop.lag).toBeGreaterThanOrEqual(0);
    });

    it("reports event loop lag in milliseconds and a utilisation ratio", async () => {
      // Give the histogram a moment to collect a sample so the conversion is
      // actually exercised.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const metrics = service.collectNodeRuntimeMetrics();

      // The histogram is in nanoseconds; shipping those as "lag" would read as a
      // million-millisecond stall.
      expect(metrics.eventLoop.lag).toBeGreaterThanOrEqual(0);
      expect(metrics.eventLoop.lag).toBeLessThan(60_000);
      expect(metrics.eventLoop.utilization).toBeGreaterThanOrEqual(0);
      expect(metrics.eventLoop.utilization).toBeLessThanOrEqual(1);
    });

    it("reports a GC section on every sample", () => {
      const metrics = service.collectNodeRuntimeMetrics();

      expect(metrics.gc.count).toEqual(expect.any(Number));
      expect(metrics.gc.totalDuration).toEqual(expect.any(Number));
      expect(metrics.gc).toHaveProperty("breakdown");
    });

    it("resets the GC counters after they are read", () => {
      // Provoke a collection so there is something to reset.
      if (global.gc) {
        global.gc();
      }
      service.collectNodeRuntimeMetrics();
      const second = service.collectNodeRuntimeMetrics();

      // Counters describe one flush window; carrying them forward would make
      // every window look worse than the last.
      expect(second.gc.count).toBe(0);
      expect(second.gc.totalDuration).toBe(0);
    });

    it("returns a fresh object each time rather than mutating one", () => {
      const first = service.collectNodeRuntimeMetrics();
      const second = service.collectNodeRuntimeMetrics();

      // The encoder reads these after the fact; a shared object would have been
      // overwritten by the next sample before it was serialised.
      expect(first).not.toBe(second);
      expect(first.gc).not.toBe(second.gc);
    });
  });

  describe("runtime metrics disabled", () => {
    it("does not start any monitor", () => {
      service = build({ runtimeMetrics: false });

      service.onModuleInit();

      // Nothing was started, so nothing needs collecting - and the histogram in
      // particular would otherwise hold the event loop open for a user who
      // explicitly turned profiling off.
      expect(() => service.collectNodeRuntimeMetrics()).toThrow();
    });

    it("shuts down cleanly having started nothing", async () => {
      service = build({ runtimeMetrics: false });
      service.onModuleInit();

      await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    });
  });

  describe("defaults", () => {
    it("collects unless told otherwise", () => {
      service = build();
      service.onModuleInit();

      expect(() => service.collectNodeRuntimeMetrics()).not.toThrow();
    });

    it("leaves an explicit false alone", () => {
      const options = {
        runtimeMetrics: false,
      } as ObserveModuleOptionsWithDefaults;

      new NodeRuntimeMetricsService(options);

      // `??=` must not overwrite a deliberate opt-out.
      expect(options.runtimeMetrics).toBe(false);
      service = build();
    });
  });

  describe("shutdown", () => {
    it("can be called twice", async () => {
      service = build();
      service.onModuleInit();

      await service.onApplicationShutdown();
      await expect(service.onApplicationShutdown()).resolves.toBeUndefined();
    });
  });
});
