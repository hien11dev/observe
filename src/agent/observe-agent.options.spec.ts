import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/**
 * Covers option resolution, not the agent.
 *
 * `runtimeMetrics` gauges how loaded a process is; `profiling` samples stacks
 * to say which code it was running. They are different signals with different
 * costs, and the cases below are mostly about keeping them independent - the
 * cheap one must not switch on the one that samples the hot path.
 *
 * `profiling` is currently shelved - commented out of `ObserveOptions`, and
 * `startContinuousProfiling()` is no longer called - so the cases that mention
 * it assert that it stays off. The implementation is kept and tested
 * elsewhere; these guard the wiring for the day it comes back.
 *
 * `runtimeMetrics` was once called `profiler`, one letter from `profiling` for
 * an unrelated signal. The alias has since been removed outright.
 */
describe("ObserveAgentWorker options", () => {
  const collect = vi.fn();
  const sharedBuffer = { addNodeRuntimeMetrics: vi.fn() };
  const metrics = { collectNodeRuntimeMetrics: collect };

  let worker: ObserveAgentWorker;

  const build = (options: Partial<ObserveModuleOptionsWithDefaults>) => {
    worker = new ObserveAgentWorker(
      sharedBuffer as never,
      { serviceId: "svc", ...options } as ObserveModuleOptionsWithDefaults,
      metrics as never,
    );
    // The worker thread and the profiler are out of scope here; only the
    // option resolution is under test.
    vi.spyOn(worker, "initializeWorker").mockImplementation(() => undefined);
    return worker;
  };

  const runtimeMetricsStarted = () =>
    Boolean(
      (worker as unknown as { runtimeMetricsInterval: unknown })
        .runtimeMetricsInterval,
    );

  afterEach(async () => {
    await worker?.onApplicationShutdown();
    vi.clearAllMocks();
  });

  it("collects runtime metrics when asked by the new name", () => {
    build({ runtimeMetrics: true }).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(true);
  });

  it("does not collect when explicitly switched off", () => {
    build({ runtimeMetrics: false }).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("collects nothing when the option is not set", () => {
    build({}).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("does not start the sampling profiler alongside runtime metrics", () => {
    // The whole reason for the rename: these are different signals with
    // different costs, and enabling the cheap one must not enable the one that
    // samples the hot path.
    build({ runtimeMetrics: true }).onModuleInit();

    expect(
      (worker as unknown as { cpuProfiler: unknown }).cpuProfiler,
    ).toBeNull();
  });

  // `profiling` is shelved: the option is commented out of ObserveOptions and
  // `startContinuousProfiling()` is no longer called from `onModuleInit`. The
  // implementation stays, so the independence this spec is about still has to
  // hold the day it is restored - hence the cast rather than deleting the case.
  // If passing it ever *does* start something, that is the regression.
  it("does not start runtime metrics alongside the sampling profiler", () => {
    build({
      profiling: { enabled: true },
    } as Partial<ObserveModuleOptionsWithDefaults>).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("leaves the shelved profiler switched off even when asked for it", () => {
    build({
      profiling: { enabled: true },
    } as Partial<ObserveModuleOptionsWithDefaults>).onModuleInit();

    expect(
      (worker as unknown as { cpuProfiler: unknown }).cpuProfiler,
    ).toBeNull();
  });
});
