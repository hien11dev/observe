import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { createInstanceDecorator } from "./create-instance-decorator.instrument.js";

const TRACE_ID_KEY = "traceId";

describe("createInstanceDecorator", () => {
  let als: AsyncLocalStorage<Map<string, any>>;
  let startedSteps: Array<{ className: string; methodName: string }>;
  let endedSteps: Array<{
    spanId: string;
    error?: unknown;
    stackAtRecord?: string;
  }>;
  let decorate: (instance: unknown) => unknown;

  const withTrace = <T>(fn: () => T): T =>
    als.run(new Map([[TRACE_ID_KEY, "trace-1"]]), fn);

  beforeEach(() => {
    als = new AsyncLocalStorage();
    startedSteps = [];
    endedSteps = [];

    const registry = {
      internalStartTraceStep: (
        _traceId: string,
        className: string,
        methodName: string,
      ) => {
        startedSteps.push({ className, methodName });
        return `step-${startedSteps.length}`;
      },
      internalEndTraceStep: (
        _traceId: string,
        spanId: string,
        _className: string,
        _methodName: string,
        _callerId: string,
        error?: unknown,
      ) => {
        // Snapshot the stack as the real registry does - it serializes it into
        // the span payload at this moment, not by holding on to the error.
        endedSteps.push({
          spanId,
          error,
          stackAtRecord: error instanceof Error ? error.stack : undefined,
        });
      },
    } as unknown as OperationTraceRegistry;

    decorate = createInstanceDecorator(als, registry, {
      traceIdKey: TRACE_ID_KEY,
      skipInstrumentation: () => false,
    });
  });

  describe("when decorating a class instance", () => {
    class UserService {
      readonly calls: unknown[][] = [];

      findAll(...args: unknown[]) {
        this.calls.push(args);
        return "ok";
      }

      fail() {
        throw new Error("boom");
      }

      async findAsync() {
        return "async-ok";
      }
    }

    it("records a trace step named after the class and method", () => {
      const service = decorate(new UserService()) as UserService;

      const result = withTrace(() => service.findAll(1, 2));

      expect(result).toEqual("ok");
      expect(startedSteps).toEqual([
        { className: "UserService", methodName: "findAll" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "UserService#findAll" }]);
    });

    it("names stack frames after the class instead of Proxy", () => {
      const service = decorate(new UserService()) as UserService;

      const stack = withTrace(() => {
        try {
          service.fail();
          return "";
        } catch (err) {
          return (err as Error).stack;
        }
      });

      // Frames contributed by the instrumentation itself must read like the
      // call the user made, not "Proxy.<something>".
      const instrumentationFrames = stack
        .split("\n")
        .filter((line) =>
          /create-instance-decorator\.instrument\.ts/.test(line),
        );

      expect(instrumentationFrames.length).toBeGreaterThan(0);
      for (const frame of instrumentationFrames) {
        expect(frame).toContain("UserService.fail");
        expect(frame).not.toContain("Proxy");
      }
    });

    it("relabels the throwing method's own frame", () => {
      const service = decorate(new UserService()) as UserService;

      const stack = withTrace(() => {
        try {
          service.fail();
          return "";
        } catch (err) {
          return (err as Error).stack;
        }
      });

      // The frame for `fail` itself runs with the proxy as its receiver, so V8
      // names it "Proxy.fail" - it has to be rewritten after the fact.
      expect(stack.split("\n")[1]).toContain("UserService.fail");
      expect(stack).not.toContain("Proxy.fail");
    });

    it("relabels each frame with its own class when method names collide", () => {
      class OrderService {
        constructor(private readonly users: UserService) {}

        fail() {
          this.users.fail();
        }
      }

      const users = decorate(new UserService()) as UserService;
      const orders = decorate(new OrderService(users)) as OrderService;

      const stack = withTrace(() => {
        try {
          orders.fail();
          return "";
        } catch (err) {
          return (err as Error).stack;
        }
      });

      const specFrames = stack
        .split("\n")
        .filter((line) =>
          /create-instance-decorator\.instrument\.spec\.ts/.test(line),
        )
        .filter((line) => /\.fail /.test(line));

      expect(stack).not.toContain("Proxy.fail");
      // Innermost first: the caller must not inherit the callee's class name.
      expect(specFrames[0]).toContain("UserService.fail");
      expect(
        specFrames.some((frame) => frame.includes("OrderService.fail")),
      ).toBe(true);
    });

    it("relabels before the step is recorded, including the root span", () => {
      class OrderService {
        constructor(private readonly users: UserService) {}

        fail() {
          this.users.fail();
        }
      }

      const users = decorate(new UserService()) as UserService;
      const orders = decorate(new OrderService(users)) as OrderService;

      expect(() => withTrace(() => orders.fail())).toThrow("boom");

      // The root span records last and is the payload the error group samples,
      // so the stack it captured must already be free of "Proxy.".
      const rootStep = endedSteps[endedSteps.length - 1];
      expect(rootStep.spanId).toEqual("OrderService#fail");
      expect(rootStep.stackAtRecord).not.toContain("Proxy.");
      expect(rootStep.stackAtRecord).toContain("OrderService.fail");
      expect(rootStep.stackAtRecord).toContain("UserService.fail");
    });

    it("keeps the original method name on the returned wrapper", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll.name).toEqual("findAll");
    });

    it("forwards arguments and preserves `this`", () => {
      const instance = new UserService();
      const service = decorate(instance) as UserService;

      withTrace(() => service.findAll("a", "b"));

      expect(instance.calls).toEqual([["a", "b"]]);
    });

    it("returns the same wrapper for repeated property access", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll).toBe(service.findAll);
    });

    it("ends the trace step with the error and re-throws", () => {
      const service = decorate(new UserService()) as UserService;

      expect(() => withTrace(() => service.fail())).toThrow("boom");
      expect(endedSteps).toHaveLength(1);
      expect(endedSteps[0].error).toBeInstanceOf(Error);
    });

    it("traces async methods once they settle", async () => {
      const service = decorate(new UserService()) as UserService;

      await expect(withTrace(() => service.findAsync())).resolves.toEqual(
        "async-ok",
      );
      expect(endedSteps).toEqual([{ spanId: "UserService#findAsync" }]);
    });

    it("does not record steps outside of an active trace", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll()).toEqual("ok");
      expect(startedSteps).toEqual([]);
    });

    it("still traces a method that was previously called outside a trace", () => {
      const service = decorate(new UserService()) as UserService;

      service.findAll();
      withTrace(() => service.findAll());

      expect(startedSteps).toEqual([
        { className: "UserService", methodName: "findAll" },
      ]);
    });

    it("respects skipInstrumentation", () => {
      const instance = new UserService();
      const skipping = createInstanceDecorator(
        als,
        {} as OperationTraceRegistry,
        {
          traceIdKey: TRACE_ID_KEY,
          skipInstrumentation: () => true,
        },
      );

      expect(skipping(instance)).toBe(instance);
    });
  });

  describe("when decorating a standalone function", () => {
    function sendEmail(to: string) {
      return `sent:${to}`;
    }

    it("records a trace step under the function label", () => {
      const wrapped = decorate(sendEmail) as typeof sendEmail;

      const result = withTrace(() => wrapped("me@example.com"));

      expect(result).toEqual("sent:me@example.com");
      expect(startedSteps).toEqual([
        { className: "Function", methodName: "sendEmail" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "Function#sendEmail" }]);
    });

    it("preserves name, arity and static properties", () => {
      const decorated = Object.assign(sendEmail, { version: 2 });
      const wrapped = decorate(decorated) as typeof decorated;

      expect(wrapped.name).toEqual("sendEmail");
      expect(wrapped.length).toEqual(1);
      expect(wrapped.version).toEqual(2);
    });

    it("keeps `Proxy` out of the stack frame", () => {
      const throwing = decorate(function explode() {
        throw new Error("boom");
      }) as () => void;

      const stack = withTrace(() => {
        try {
          throwing();
          return "";
        } catch (err) {
          return (err as Error).stack;
        }
      });

      expect(stack).toContain("explode");
      expect(stack).not.toContain("Proxy");
    });

    it("propagates the caller's `this`", () => {
      const holder = {
        name: "holder",
        greet: decorate(function greet(this: { name: string }) {
          return this.name;
        }) as () => string,
      };

      expect(withTrace(() => holder.greet())).toEqual("holder");
    });

    it("leaves classes untouched", () => {
      class Repository {}

      expect(decorate(Repository)).toBe(Repository);
    });

    it("does not trace recursive calls twice", () => {
      // Recursing through the wrapper - rather than through the inner function
      // binding, which would bypass instrumentation - is what exercises the
      // re-entrancy guard.
      const countdown = decorate(function step(n: number): number {
        return n <= 0 ? 0 : countdown(n - 1);
      }) as (n: number) => number;

      withTrace(() => countdown(3));

      expect(startedSteps).toHaveLength(1);
    });
  });
});
