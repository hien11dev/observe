import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import * as os from "node:os";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { NodeRuntimeMetrics } from "../interfaces/node-runtime-metrics.interface.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";

@Injectable()
export class NodeRuntimeMetricsService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(NodeRuntimeMetricsService.name);
  private eventLoopDelayMonitor: ReturnType<
    typeof monitorEventLoopDelay
  > | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private gcCount = 0;
  private gcTotalDuration = 0;
  private gcBreakdown: NodeRuntimeMetrics["gc"]["breakdown"] = null;
  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuUsageTimestamp: number | null = null;
  private osTotalMemory: number;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
  ) {
    this.options.runtimeMetrics ??= true;
  }

  onModuleInit() {
    if (!this.options.runtimeMetrics) {
      return;
    }

    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuUsageTimestamp = Date.now();
    this.osTotalMemory = os.totalmem();

    this.monitorEventLoopDelay();
    this.observeGcPerformance();
  }

  async onApplicationShutdown() {
    if (this.gcObserver) {
      this.gcObserver.disconnect();
      this.logger.debug("Garbage collection observer disconnected.");
    }

    if (this.eventLoopDelayMonitor) {
      this.eventLoopDelayMonitor.disable();
      this.logger.debug("Event loop delay monitoring disabled.");
    }
  }

  monitorEventLoopDelay() {
    if (this.options.debug) {
      this.logger.debug("Monitoring event loop delay.");
    }
    const h = monitorEventLoopDelay();
    h.enable();

    this.eventLoopDelayMonitor = h;
  }

  observeGcPerformance() {
    if (this.options.debug) {
      this.logger.debug("Observing garbage collection performance.");
    }

    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType !== "gc") {
          continue;
        }

        this.gcCount++;
        this.gcTotalDuration += entry.duration;

        if ("detail" in entry && "kind" in (entry.detail as object)) {
          const detail = entry.detail as { kind: number; duration: number };
          const kind =
            detail.kind === 1
              ? "major"
              : detail.kind === 2
                ? "minor"
                : detail.kind === 4
                  ? "incremental"
                  : undefined;

          if (!kind) {
            continue;
          }

          if (this.gcBreakdown) {
            this.gcBreakdown[kind] = this.gcBreakdown[kind] || {
              count: 0,
              duration: 0,
            };
            this.gcBreakdown[kind].count++;
            this.gcBreakdown[kind].duration += entry.duration;
          } else {
            this.gcBreakdown = {
              minor: { count: 0, duration: 0 },
              major: { count: 0, duration: 0 },
              incremental: { count: 0, duration: 0 },
            };
            this.gcBreakdown[kind].count++;
            this.gcBreakdown[kind].duration += entry.duration;
          }
        }
      }
    });

    this.gcObserver.observe({ type: "gc", buffered: true });
  }

  collectNodeRuntimeMetrics(): NodeRuntimeMetrics {
    const timestamp = Date.now();
    const elapsedTime = timestamp - this.lastCpuUsageTimestamp;
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const diffCpuUsage = process.cpuUsage(this.lastCpuUsage);
    const eventLoop = performance.eventLoopUtilization();
    // `mean` is NaN until the histogram has recorded its first sample, so a
    // flush that lands immediately after startup would otherwise ship NaN into
    // a numeric column - where it survives, poisons every average built over it
    // and makes the runtime alert comparisons undefined.
    const meanDelay = this.eventLoopDelayMonitor.mean;
    const lag = Number.isFinite(meanDelay) ? meanDelay / 1e6 : 0; // ns → ms

    const metrics: NodeRuntimeMetrics = {
      memory: {
        rss: memoryUsage.rss / 1024 / 1024, // Convert bytes to MB
        heapTotal: memoryUsage.heapTotal / 1024 / 1024, // Convert bytes to MB
        heapUsed: memoryUsage.heapUsed / 1024 / 1024, // Convert bytes to MB
        external: memoryUsage.external / 1024 / 1024, // Convert bytes to MB
        arrayBuffers: memoryUsage.arrayBuffers / 1024 / 1024, // Convert bytes to MB
        percentageUsed: (memoryUsage.rss / this.osTotalMemory) * 100,
      },
      cpu: {
        user: diffCpuUsage.user / 1000, // Convert from µs to ms
        system: diffCpuUsage.system / 1000, // Convert from µs to ms
        percentageUsed:
          ((diffCpuUsage.user + diffCpuUsage.system) / 1000 / elapsedTime) *
          100,
      },
      eventLoop: {
        lag,
        utilization: eventLoop.utilization,
      },
      gc: {
        count: this.gcCount,
        totalDuration: this.gcTotalDuration,
        breakdown: { ...this.gcBreakdown },
      },
    };

    this.resetGcMetrics();
    this.updateLastCpuUsage(cpuUsage, timestamp);

    return metrics;
  }

  private resetGcMetrics() {
    this.gcCount = 0;
    this.gcTotalDuration = 0;
    this.gcBreakdown = null;
  }

  private updateLastCpuUsage(cpuUsage: NodeJS.CpuUsage, timestamp: number) {
    this.lastCpuUsage = cpuUsage;
    this.lastCpuUsageTimestamp = timestamp;
  }
}
