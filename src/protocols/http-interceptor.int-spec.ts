import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Observable } from "rxjs";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

/**
 * The shape every pass-through interceptor has - `@sentry/nestjs`'s
 * `SentryTracingInterceptor` included: `intercept()` returns the downstream
 * Observable synchronously, so the span the instrumentation opens for it
 * closes before the handler runs.
 */
@Injectable()
class PassThroughInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle();
  }
}

@Controller()
class OrdersController {
  @Get("orders")
  findAll() {
    return [{ id: 1 }];
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: PassThroughInterceptor }],
})
class InterceptorTestModule {}

/**
 * Nest binds the stage after an interceptor to the async context in which
 * `next.handle()` was called (`AsyncResource.bind` in its interceptors
 * consumer), so the handler inherits the interceptor's span as its caller -
 * a span that has already completed by the time the handler starts.
 */
describe("ObserveModule: HTTP collection with a global interceptor", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      InterceptorTestModule,
      { instrument: ObserveInstrument, logger: false },
    );
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("serves the request and records the handler span at the root", async () => {
    await request(app.getHttpServer()).get("/orders").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/orders",
    );

    expect(snapshot.attributes?.statusCode).toBe(200);
    expect(snapshot.traces.map((node) => node.methodKey)).toEqual(
      expect.arrayContaining(["intercept", "findAll"]),
    );
  });
});
