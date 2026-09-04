import { AsyncLocalStorage } from "async_hooks";
import { RpcObserveAgentService } from "./rpc-observe-agent.service.js";

/**
 * `@nestjs/microservices` is an optional peer: the agent must hook RPC
 * targets when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("RpcObserveAgentService", () => {
  let startedTraces: Array<{
    traceId: string;
    data: { tags?: Record<string, string | number | boolean> };
  }>;

  const createAgent = (
    subscribe: (...args: unknown[]) => unknown,
    overrides: Record<string, unknown> = {},
  ) => {
    startedTraces = [];
    const registry = {
      startTrace: (traceId: string, data: unknown) => {
        startedTraces.push({ traceId, data } as (typeof startedTraces)[number]);
      },
    };
    return new RpcObserveAgentService(
      new AsyncLocalStorage<Map<string, any>>(),
      {
        traceIdKey: "traceId",
        traceIdGenerator: () => "generated-trace",
        serviceId: "svc-1",
        ...overrides,
      } as never,
      { getRpcTargetRegistry: () => ({ subscribe }) } as never,
      registry as never,
      {} as never,
      { shouldCapture: () => true } as never,
    );
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to the RPC target registry when @nestjs/microservices is installed", () => {
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const agent = createAgent(subscribe);

    agent.onModuleInit();

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("stays inert when @nestjs/microservices is not installed", () => {
    vi.spyOn(
      RpcObserveAgentService.prototype as unknown as {
        loadMicroservices: () => unknown;
      },
      "loadMicroservices",
    ).mockReturnValue(undefined);
    const subscribe = vi.fn();
    const agent = createAgent(subscribe);

    expect(() => agent.onModuleInit()).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
    expect(() => agent.onModuleDestroy()).not.toThrow();
  });

  describe("getOperationIdFromContext", () => {
    const getOperationId = (ctx: unknown): string => {
      const agent = createAgent(() => ({ unsubscribe: vi.fn() }));
      agent.onModuleInit();
      return (
        agent as unknown as {
          getOperationIdFromContext: (ctx: unknown) => string;
        }
      ).getOperationIdFromContext(ctx);
    };

    it("falls back to getPattern for a custom transport's own context class", () => {
      expect(getOperationId({ getPattern: () => "custom.pattern" })).toBe(
        "custom.pattern",
      );
    });

    it("answers 'unknown' rather than throwing when a custom context exposes no accessor", () => {
      expect(getOperationId({})).toBe("unknown");
    });
  });

  it("adopts propagation metadata for gRPC calls", async () => {
    const agent = createAgent(() => ({ unsubscribe: vi.fn() }), {
      serviceName: "orders-api",
    });
    agent.onModuleInit();

    agent.startGrpcRequestTracing(
      (agent as unknown as { microservices: { Transport: { GRPC: number } } })
        .microservices.Transport.GRPC,
      {
        operationId: "Orders.FindOne",
        metadata: {
          get: (key: string) =>
            key === "traceparent"
              ? "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
              : key === "baggage"
                ? "tenant=acme"
                : undefined,
        },
        request: {},
      },
      async () => undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startedTraces[0]).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      data: {
        tags: {
          "rpc.system": "grpc",
          "rpc.method": "Orders.FindOne",
          "service.name": "orders-api",
          "baggage.tenant": "acme",
        },
      },
    });
  });
});
