import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import {
  BaseRpcContext,
  KafkaContext,
  MqttContext,
  NatsContext,
  RedisContext,
  RmqContext,
  Server,
  TcpContext,
  Transport,
} from "@nestjs/microservices";
import { AsyncLocalStorage } from "async_hooks";
import { Subscription } from "rxjs";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { RequestSnapshot } from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";

interface GrpcCall<TRequest = any, TMetadata = any> {
  request: TRequest;
  metadata: TMetadata;
  operationId: string;
}

@Injectable()
export class RpcObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit, OnModuleDestroy
{
  private rpcTargetAddedSubscription: Subscription | undefined;

  constructor(
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly modulesContainer: ModulesContainer,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly traceSamplerService: TraceSamplerService,
  ) {}

  onModuleInit() {
    this.rpcTargetAddedSubscription = this.modulesContainer
      .getRpcTargetRegistry?.<Server>()
      .subscribe((target) => this.registerRpcHooks(target));
  }

  onModuleDestroy() {
    if (this.rpcTargetAddedSubscription) {
      this.rpcTargetAddedSubscription.unsubscribe();
    }
  }

  registerRpcHooks(target: Server) {
    target.setOnProcessingStartHook(
      (
        transportId: Transport | symbol,
        ctx: unknown,
        done: () => Promise<any>,
      ) => {
        if (transportId === Transport.GRPC) {
          this.startGrpcRequestTracing(transportId, ctx as GrpcCall, done);
          return;
        }
        this.startRpcRequestTracing(transportId, ctx as BaseRpcContext, done);
      },
    );

    target.setOnProcessingEndHook(
      (transportId: Transport | symbol, ctx: unknown) => {
        this.endRpcRequestTracing(
          transportId,
          ctx as BaseRpcContext | GrpcCall,
        );
      },
    );
  }

  /**
   * Names the transport for the snapshot's `protocol` field.
   *
   * A custom transport is registered under a symbol rather than a `Transport`
   * member, and indexing the enum with one yields `undefined` - so every custom
   * transport used to arrive with no protocol at all.
   */
  private toProtocolName(transportId: Transport | symbol): string {
    return typeof transportId === "symbol"
      ? transportId.description ?? "custom"
      : Transport[transportId];
  }

  startRpcRequestTracing(
    transportId: Transport | symbol,
    ctx: BaseRpcContext,
    done: () => Promise<any>,
  ) {
    // The same map `run` is given, rather than `getStore()` inside the callback:
    // identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    this.asyncLocalStorage.run(store, () => {
      const traceId = this.options.traceIdGenerator(ctx);
      store.set(this.options.traceIdKey, traceId);

      if (this.options.rpc?.setAttributes) {
        const attributes = this.options.rpc?.setAttributes?.(transportId, ctx);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      // setImmediate(() => {
      if (this.options.rpc?.ignore?.(transportId, ctx)) {
        return done();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("rpc", {
        transport: transportId.toString(),
        ctx: ctx,
      });
      if (!shouldCapture) {
        return done();
      }
      this.operationTraceRegistry.startTrace(traceId, {
        protocol: this.toProtocolName(transportId),
        operationId: this.getOperationIdFromContext(ctx),
        tags: this.options.rpc?.tags,
      });
      done();
      // });
    });
  }

  startGrpcRequestTracing(
    transportId: Transport | symbol,
    call: GrpcCall,
    done: () => Promise<any>,
  ) {
    // As above: the map `run` is given, not looked back up.
    const store = new Map<KeyOf<Store>, any>();
    this.asyncLocalStorage.run(store, () => {
      const traceId = this.options.traceIdGenerator(call);
      store.set(this.options.traceIdKey, traceId);

      if (this.options.grpc?.setAttributes) {
        const attributes = this.options.grpc?.setAttributes?.(call);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      setTimeout(() => {
        if (this.options.grpc?.ignore?.(call)) {
          return done();
        }

        const shouldCapture = this.traceSamplerService.shouldCapture("grpc", {
          call,
        });
        if (!shouldCapture) {
          return done();
        }
        this.operationTraceRegistry.startTrace(traceId, {
          protocol: this.toProtocolName(transportId),
          operationId: call.operationId,
          tags: this.options.grpc?.tags,
        });
        done();
      }, 0);
    });
  }

  endRpcRequestTracing(
    transportId: Transport | symbol,
    ctx: BaseRpcContext | GrpcCall,
  ): void {
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
      if (transportId === Transport.GRPC) {
        if (this.options.grpc?.getUserId) {
          userId = this.options.grpc?.getUserId?.(ctx as GrpcCall);
        }
      } else {
        if (this.options.rpc?.getUserId) {
          userId = this.options.rpc?.getUserId?.(
            transportId,
            ctx as BaseRpcContext,
          );
        }
      }
      this.operationTraceRegistry.endTrace(traceId, {
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

  private getOperationIdFromContext(ctx: BaseRpcContext): string {
    switch (true) {
      case ctx instanceof KafkaContext:
      case ctx instanceof MqttContext:
        return ctx.getTopic();
      case ctx instanceof RmqContext:
      case ctx instanceof TcpContext:
        return ctx.getPattern();
      case ctx instanceof RedisContext:
        return ctx.getChannel();
      case ctx instanceof NatsContext:
        return ctx.getSubject();
      default:
        throw new Error(`Unsupported context type: ${ctx.constructor.name}`);
    }
  }
}
