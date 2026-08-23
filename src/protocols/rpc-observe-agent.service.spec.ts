import { AsyncLocalStorage } from "async_hooks";
import { RpcObserveAgentService } from "./rpc-observe-agent.service.js";

/**
 * `@nestjs/microservices` is an optional peer: the agent must hook RPC
 * targets when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("RpcObserveAgentService", () => {
  const options = { traceIdKey: "traceId" } as never;

  const createAgent = (subscribe: (...args: unknown[]) => unknown) =>
    new RpcObserveAgentService(
      new AsyncLocalStorage<Map<string, any>>(),
      options,
      { getRpcTargetRegistry: () => ({ subscribe }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

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
});
