export interface NodeRuntimeMetrics {
  cpu: {
    user: number;
    system: number;
    percentageUsed: number;
  };
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
    percentageUsed: number;
  };
  gc: {
    count: number;
    totalDuration: number;
    breakdown?: {
      minor: {
        count: number;
        duration: number;
      };
      major: {
        count: number;
        duration: number;
      };
      incremental: {
        count: number;
        duration: number;
      };
    };
  };
  eventLoop: {
    lag: number;
    utilization: number;
  };
}
