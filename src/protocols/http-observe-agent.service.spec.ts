import { AsyncLocalStorage } from "async_hooks";
import { HttpAdapterHost } from "@nestjs/core";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { HttpObserveAgentService } from "./http-observe-agent.service.js";

describe("HttpObserveAgentService", () => {
  let startedTraces: Array<{
    traceId: string;
    data: {
      attributes?: { originalUrl?: string };
      tags?: Record<string, string | number | boolean>;
    };
  }>;

  const createService = (
    http: ObserveModuleOptionsWithDefaults["http"] = {},
    overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
  ) => {
    startedTraces = [];
    const registry = {
      startTrace: (traceId: string, data: unknown) => {
        startedTraces.push({ traceId, data } as (typeof startedTraces)[number]);
      },
    } as unknown as OperationTraceRegistry;

    return new HttpObserveAgentService(
      {
        httpAdapter: { setOnRouteTriggered: () => {} },
      } as unknown as HttpAdapterHost,
      new AsyncLocalStorage<Map<string, any>>(),
      {
        traceIdKey: "traceId",
        traceIdGenerator: () => "trace-1",
        http,
        serviceId: "svc-1",
        ...overrides,
      } as unknown as ObserveModuleOptionsWithDefaults,
      registry,
      {} as ObserveAgentSharedBuffer,
      { shouldCapture: () => true } as unknown as TraceSamplerService,
    );
  };

  const trace = (
    service: HttpObserveAgentService<any>,
    url: string,
    headers: Record<string, unknown> = {},
  ) =>
    service.startHttpRequestTracing(
      { url, method: "GET", protocol: "http", headers },
      {},
      () => {},
    );

  describe("queryParamsObfuscateRegex", () => {
    it("applies a non-global pattern instead of throwing", () => {
      // `replaceAll` refuses a non-global RegExp outright; unnormalised, this
      // threw inside the request hook and turned every traced request into a
      // 500 - while ignored health checks kept passing readiness probes.
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/,
      });

      expect(() => trace(service, "/items?internal=abc")).not.toThrow();
      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]",
      );
    });

    it("masks every occurrence, not just the first", () => {
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/,
      });

      trace(service, "/items?internal=abc&x=1&internal=def");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]&x=1&[REDACTED]",
      );
    });

    it("leaves a pattern that already has the global flag as-is", () => {
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/g,
      });

      trace(service, "/items?internal=abc&internal=def");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]&[REDACTED]",
      );
    });

    it("records the URL untouched when no pattern is configured", () => {
      const service = createService();

      trace(service, "/items?x=1");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?x=1",
      );
    });

    it("falls back without rewriting a non-path request target", () => {
      const service = createService();

      trace(service, "example.com:443");

      expect(startedTraces[0].data.tags).toMatchObject({
        "url.path": "example.com:443",
      });
    });

    it("adopts W3C context and adds OTel semantic tags", () => {
      const service = createService(
        {},
        {
          serviceName: "orders-api",
          serviceVersion: "1.2.3",
          deploymentEnvironment: "test",
        },
      );

      trace(service, "/items?x=1", {
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        baggage: "tenant=acme",
      });

      expect(startedTraces[0]).toMatchObject({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        data: {
          tags: {
            "span.kind": "server",
            "http.request.method": "GET",
            "url.path": "/items",
            "url.query": "x=1",
            "url.scheme": "http",
            "service.name": "orders-api",
            "service.version": "1.2.3",
            "service.instance.id": "svc-1",
            "deployment.environment": "test",
            "baggage.tenant": "acme",
          },
        },
      });
    });

    it("prefers traceparent over x-request-id when both are present", () => {
      const service = createService();

      trace(service, "/items?x=1", {
        traceparent:
          "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-request-id": "legacy-request-id",
      });

      expect(startedTraces[0].traceId).toEqual(
        "4bf92f3577b34da6a3ce929d0e0e4736",
      );
    });

    it("normalizes the URL scheme tag", () => {
      const service = createService();

      service.startHttpRequestTracing(
        { url: "/items", method: "GET", protocol: "http/1.1", headers: {} },
        {},
        () => {},
      );

      expect(startedTraces[0].data.tags).toMatchObject({
        "url.scheme": "http",
      });
    });
  });
});
