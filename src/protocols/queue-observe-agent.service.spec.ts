import { ProcessorDecoratorService } from "@nestjs/bullmq/dist/instrument/processor-decorator.service.js";
import { AsyncLocalStorage } from "async_hooks";
import { QueueObserveAgentService } from "./queue-observe-agent.service.js";

/**
 * `@nestjs/bullmq` is an optional peer: the agent must patch the processor
 * decorator when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("QueueObserveAgentService", () => {
  const prototype = ProcessorDecoratorService.prototype as {
    decorate?: unknown;
  };
  const originalDecorate = prototype.decorate;

  const createAgent = () =>
    new QueueObserveAgentService(
      {} as never,
      { traceIdKey: "traceId" } as never,
      {} as never,
      new AsyncLocalStorage<Map<string, any>>(),
    );

  afterEach(() => {
    prototype.decorate = originalDecorate;
    vi.restoreAllMocks();
  });

  it("patches the processor decorator when @nestjs/bullmq is installed", () => {
    createAgent();

    expect(prototype.decorate).toEqual(expect.any(Function));
    expect(prototype.decorate).not.toBe(originalDecorate);
  });

  it("stays inert when @nestjs/bullmq is not installed", () => {
    vi.spyOn(
      QueueObserveAgentService.prototype as unknown as {
        loadProcessorDecoratorService: () => unknown;
      },
      "loadProcessorDecoratorService",
    ).mockReturnValue(undefined);

    expect(() => createAgent()).not.toThrow();
    expect(prototype.decorate).toBe(originalDecorate);
  });
});
