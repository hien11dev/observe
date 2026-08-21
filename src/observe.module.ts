import {
  DynamicModule,
  Inject,
  Logger,
  Module,
  NestApplicationOptions,
  Provider,
} from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  ModulesContainer,
} from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "./agent/observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./agent/observe-agent.worker.js";
import { createInstanceDecorator } from "./instrument/create-instance-decorator.instrument.js";
import {
  CreateObserveModuleOptions,
  ObserveModuleAsyncOptions,
  ObserveModuleOptionsWithDefaults,
  ObserveOptionsFactory,
  ObserveOptions,
} from "./interfaces/observe-options.interface.js";
import { CALLER_METADATA_KEY, OBSERVE_OPTIONS } from "./observe.constants.js";
import { GraphQLObserveAgentService } from "./protocols/graphql-observe-agent.service.js";
import { HttpObserveAgentService } from "./protocols/http-observe-agent.service.js";
import { QueueObserveAgentService } from "./protocols/queue-observe-agent.service.js";
import { RpcObserveAgentService } from "./protocols/rpc-observe-agent.service.js";
import { LoggerPatcherService } from "./services/logger-patcher.service.js";
import { NodeRuntimeMetricsService } from "./services/node-runtime-metrics.service.js";
import { OperationTraceRegistry } from "./services/operation-trace.registry.js";
import { StdoutForwarderService } from "./services/stdout-forwarder.service.js";
import { TraceSamplerService } from "./services/trace-sampler.service.js";
import { TracerService } from "./services/tracer.service.js";
import { KeyOf } from "./types/key-of.type.js";
import { assertModuleOptions } from "./utils/assert-module-options.util.js";
import { defaultTraceIdGenerator } from "./utils/default-trace-id-generator.util.js";

export function createObserveModule<Store extends Record<string, unknown>>(
  options: CreateObserveModuleOptions = {},
) {
  options.traceIdKey ??= "traceId";
  options.attachTraceIdToLogs ??= true;
  options.traceIdGenerator ??= defaultTraceIdGenerator;

  const asyncLocalStorage = new AsyncLocalStorage<Map<KeyOf<Store>, unknown>>();
  const operationTraceRegistry = new OperationTraceRegistry(
    asyncLocalStorage as AsyncLocalStorage<
      Map<
        KeyOf<{
          [CALLER_METADATA_KEY]: string;
        }>,
        any
      >
    >,
    options.sourceContext,
  );

  @Module({
    imports: [DiscoveryModule],
    providers: [
      {
        provide: "ASSERT_MODULE_OPTIONS",
        useFactory: assertModuleOptions,
        inject: [{ token: OBSERVE_OPTIONS, optional: true }],
      },
      {
        provide: AsyncLocalStorage,
        useValue: asyncLocalStorage,
      },
      {
        provide: OperationTraceRegistry,
        useValue: operationTraceRegistry,
      },
      TracerService,
      LoggerPatcherService,
      HttpObserveAgentService,
      RpcObserveAgentService,
      // A no-op unless @nestjs/graphql is installed and registered; it claims
      // the request lifecycle hooks only when it finds them.
      GraphQLObserveAgentService,
      ObserveAgentWorker,
      ObserveAgentSharedBuffer,
      TraceSamplerService,
      NodeRuntimeMetricsService,
      // Registered unconditionally; the service itself is a no-op unless
      // `forwardLogs` is enabled, and it redacts before anything is buffered.
      StdoutForwarderService,
      QueueObserveAgentService,
    ],
    exports: [AsyncLocalStorage, TracerService],
  })
  class ObserveModule {
    readonly logger = new Logger(ObserveModule.name);

    constructor(
      readonly httpAdapterHost: HttpAdapterHost,
      readonly asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>,
      @Inject(OBSERVE_OPTIONS)
      readonly options: ObserveModuleOptionsWithDefaults,
    ) {}

    static forRoot(observeOpts: ObserveOptions): DynamicModule {
      return {
        global: true,
        module: ObserveModule,
        providers: [
          {
            provide: OBSERVE_OPTIONS,
            useValue: {
              ...options,
              ...observeOpts,
            },
          },
        ],
      };
    }

    static forRootAsync(options: ObserveModuleAsyncOptions): DynamicModule {
      return {
        module: ObserveModule,
        global: options.global ?? true,
        imports: options.imports,
        providers: [
          ...this.createAsyncProviders(options),
          ...(options.extraProviders || []),
        ],
      };
    }

    static createAsyncProviders(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider[] {
      if (asyncOptions.useExisting || asyncOptions.useFactory) {
        return [this.createAsyncOptionsProvider(asyncOptions)];
      }
      return [
        this.createAsyncOptionsProvider(asyncOptions),
        {
          provide: asyncOptions.useClass,
          useClass: asyncOptions.useClass,
        },
      ];
    }

    static createAsyncOptionsProvider(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider {
      if (asyncOptions.useFactory) {
        return {
          provide: OBSERVE_OPTIONS,
          useFactory: async (...args: any[]) => {
            const opts = await asyncOptions.useFactory(...args);
            return {
              ...options,
              ...opts,
            };
          },
          inject: asyncOptions.inject || [],
        };
      }
      return {
        provide: OBSERVE_OPTIONS,
        useFactory: async (optionsFactory: ObserveOptionsFactory) => ({
          ...options,
          ...(await optionsFactory.createWhispprOptions()),
        }),
        inject: [asyncOptions.useExisting || asyncOptions.useClass],
      };
    }
  }

  return {
    ObserveInstrument: {
      instanceDecorator: createInstanceDecorator<Store>(
        asyncLocalStorage,
        operationTraceRegistry,
        {
          traceIdKey: options.traceIdKey,
          skipInstrumentation: (instance) => {
            return (
              [asyncLocalStorage, operationTraceRegistry].includes(
                instance as AsyncLocalStorage<any> | OperationTraceRegistry,
              ) ||
              instance instanceof TraceSamplerService ||
              instance instanceof TracerService ||
              instance instanceof ObserveAgentSharedBuffer ||
              // Its methods run *inside* the traces it opens, so instrumenting
              // it would put a span for the agent itself at the root of every
              // GraphQL operation it records.
              instance instanceof GraphQLObserveAgentService ||
              // Nest's discovery machinery, which the GraphQL agent walks to
              // map root fields back to their resolver classes. It has to stay
              // unproxied: ModulesContainer extends Map, and a Map method
              // invoked with the instrumentation proxy as its receiver throws
              // "called on incompatible receiver" - Map's internal slots live
              // on the target, and a proxy does not forward them.
              instance instanceof ModulesContainer ||
              instance instanceof DiscoveryService ||
              instance instanceof MetadataScanner ||
              // `@nestjs/graphql`'s ResolverDecoratorHost, matched structurally
              // because the package is an optional peer. Its `onRequestStart` /
              // `onRequestEnd` methods invoke the hooks this module registers,
              // so instrumenting it would wrap the agent's own bookkeeping in
              // spans inside every operation it measures.
              isResolverDecoratorHost(instance)
            );
          },
        },
      ),
    } as NestApplicationOptions["instrument"],
    ObserveModule,
  };
}

/**
 * Identifies `@nestjs/graphql`'s `ResolverDecoratorHost` without importing the
 * package, which is an optional peer. `decorate`/`setDecorator` plus the
 * request-hook accessors are its public surface and unlikely to appear together
 * on anything else.
 */
function isResolverDecoratorHost(instance: unknown): boolean {
  const candidate = instance as {
    decorate?: unknown;
    setDecorator?: unknown;
    setOnRequestStartHook?: unknown;
  };
  return (
    typeof candidate?.decorate === "function" &&
    typeof candidate.setDecorator === "function" &&
    typeof candidate.setOnRequestStartHook === "function"
  );
}
