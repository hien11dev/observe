import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { Subscription } from "rxjs";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { RequestSnapshot } from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import { redactUrlQuery } from "../utils/redact-url-query.js";

/**
 * How long an aborted request's handler gets to finish its spans before the
 * trace is dropped from the registry. Generous next to a typical handler, tiny
 * next to a leak that never frees.
 */
const ABORTED_TRACE_EVICTION_GRACE_MS = 30_000;

@Injectable()
export class HttpObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit, OnModuleDestroy
{
  private httpAdapterInitSubscription: Subscription | undefined;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly traceSamplerService: TraceSamplerService,
  ) {
    // The "setOnRouteTriggered" hook must be set immediately
    // to ensure that route metadata is captured correctly.
    const { httpAdapter } = this.httpAdapterHost;
    if (!httpAdapter) {
      return;
    }
    if (!("setOnRouteTriggered" in httpAdapter)) {
      throw new Error(
        "The HTTP adapter does not support the 'setOnRouteTriggered' method. Please ensure you are using the latest version of the NestJS HTTP adapter that supports this method.",
      );
    }

    httpAdapter.setOnRouteTriggered(
      (requestMethod: RequestMethod, path: string) => {
        const store = this.asyncLocalStorage.getStore();
        if (!store) {
          return;
        }
        const traceId = store.get(this.options.traceIdKey);
        if (!traceId) {
          return;
        }
        this.operationTraceRegistry.addRouteMetadataToTrace(
          traceId,
          requestMethod,
          path,
        );
      },
    );
  }

  onModuleInit() {
    this.httpAdapterInitSubscription = this.httpAdapterHost.init$?.subscribe(
      () => this.registerHttpHooks(),
    );
  }

  onModuleDestroy() {
    if (this.httpAdapterInitSubscription) {
      this.httpAdapterInitSubscription.unsubscribe();
    }
  }

  registerHttpHooks() {
    const { httpAdapter } = this.httpAdapterHost;
    if (!httpAdapter) {
      return;
    }

    httpAdapter.setOnRequestHook(
      (
        req: { url: string; method: string; protocol: string },
        res: unknown,
        done: () => void,
      ) => {
        this.startHttpRequestTracing(req, res, done);
      },
    );

    httpAdapter.setOnResponseHook(
      (
        req: unknown,
        res: {
          statusCode: number;
        },
      ) => {
        this.endHttpRequestTracing(req, res);
      },
    );
  }

  startHttpRequestTracing(
    req: { url: string; method: string; protocol: string },
    res: unknown,
    done: () => void,
  ) {
    this.asyncLocalStorage.run(new Map<KeyOf<Store>, any>(), () => {
      const traceId = this.options.traceIdGenerator(req);
      const store = this.asyncLocalStorage.getStore();
      store.set(this.options.traceIdKey, traceId);

      if (this.options.http?.setAttributes) {
        const attributes = this.options.http?.setAttributes?.(req);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      if (this.shouldIgnoreRequest(req)) {
        return done();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("http", {
        url: req.url,
        method: req.method,
      });
      if (!shouldCapture) {
        return done();
      }
      // Sensitive query parameters are masked whether or not the deployment
      // configured anything: an opt-in redactor protects only those who
      // already knew to ask, and a reset token in a stored URL is the same
      // disclosure either way. A configured regex still applies, on top rather
      // than instead - it exists for the keys only that deployment knows
      // about.
      const redactedUrl = redactUrlQuery(req.url);
      const originalUrl = this.options.http?.queryParamsObfuscateRegex
        ? redactedUrl.replaceAll(
            this.options.http.queryParamsObfuscateRegex,
            "[REDACTED]",
          )
        : redactedUrl;

      this.operationTraceRegistry.startTrace(traceId, {
        protocol: req.protocol,
        tags: this.options.http?.tags,
        attributes: {
          method: req.method,
          originalUrl,
        },
      });
      this.evictTraceOnClientAbort(res, traceId);
      done();
    });
  }

  endHttpRequestTracing(req: unknown, res: { statusCode: number }): void {
    const store = this.asyncLocalStorage.getStore();
    if (!store) {
      return;
    }
    const traceId = store.get(this.options.traceIdKey);
    if (!traceId) {
      return;
    }
    setTimeout(async () => {
      let userId: string | undefined;
      if (this.options.http?.getUserId) {
        userId = this.options.http?.getUserId?.(req);
      }
      this.operationTraceRegistry.endTrace(traceId, {
        statusCode: res.statusCode,
        userId,
      });

      const snapshot = await this.operationTraceRegistry.pluckSnapshot(traceId);
      if (!snapshot) {
        return;
      }
      this.observeAgentSharedBuffer.insertRequestSnapshot(
        snapshot as RequestSnapshot,
      );
    }, 0);
  }

  /**
   * Frees the trace when the client goes away before the response finishes.
   *
   * The adapter's response hook rides `res.on("finish")`, and an aborted
   * request never emits it - the socket emits `close` instead. Without this,
   * every abort leaves its snapshot and span map in the registry for the life
   * of the process; on an ingest endpoint taking 16MB bodies over slow links,
   * aborts are routine, not exceptional.
   *
   * On the normal path `close` follows `finish` with `writableFinished`
   * already true, so this stays a no-op there - `endHttpRequestTracing` has
   * either plucked the trace or is about to.
   *
   * Eviction is deferred, not immediate: Express does not cancel the handler
   * on abort, so its spans are usually still closing when `close` fires, and
   * each one ending after the snapshot is gone would log an error. The grace
   * period lets the handler drain first; `unref` keeps the timer from holding
   * a shutting-down process open.
   */
  private evictTraceOnClientAbort(res: unknown, traceId: string): void {
    const response = res as {
      on?: (event: string, listener: () => void) => void;
      writableFinished?: boolean;
    };
    if (typeof response?.on !== "function") {
      return;
    }
    response.on("close", () => {
      if (response.writableFinished) {
        return;
      }
      const timer = setTimeout(
        () => this.operationTraceRegistry.abandonTrace(traceId),
        ABORTED_TRACE_EVICTION_GRACE_MS,
      );
      timer.unref?.();
    });
  }

  private shouldIgnoreRequest(req: { url: string; method: string }): boolean {
    if (typeof this.options.http?.ignore === "function") {
      return this.options.http.ignore(req);
    }
    if (Array.isArray(this.options.http?.ignore)) {
      const blocklist = this.options.http.ignore;
      return blocklist.some((item) => {
        if (typeof item === "string") {
          return req.url === item;
        }
        if (item instanceof RegExp) {
          return item.test(req.url);
        }
        if (typeof item === "object") {
          return (
            item.method === req.method &&
            (typeof item.path === "string"
              ? req.url === item.path
              : item.path.test(req.url))
          );
        }

        return false;
      });
    }
    return false;
  }
}
