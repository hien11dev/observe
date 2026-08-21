import { IntrinsicException, Logger, RequestMethod } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { activeSliceRecorder } from "../profiling/span-slice-recorder.js";
import { randomUUID } from "crypto";
import { JobSnapshot } from "../interfaces/index.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { CreateObserveModuleOptions } from "../interfaces/observe-options.interface.js";
import {
  CompleteTraceEventNode,
  OngoingTraceEventNode,
} from "../interfaces/trace-events.interfaces.js";
import { TraceSpanDelegate } from "../trace-span.delegate.js";
import { KeyOf } from "../types/key-of.type.js";
import { CodeFrame, collectCodeFrames } from "../utils/source-context.util.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";

const SNAPSHOT_COMPLETION_TIMEOUT_MS = 1000;

type TraceId = string;
type SnapshotWithSignal = (RequestSnapshot | JobSnapshot) & {
  /**
   * Internal counter to track references to this snapshot.
   */
  refsCounter: number;
  /**
   * Used to determine when the snapshot is complete.
   * When `refsCounter` equals `refsMarkedAsComplete`, the snapshot is complete.
   */
  refsMarkedAsComplete: number;
  /**
   * Status code stood in for a root span that threw, on protocols that carry no
   * status code of their own (RPC, gRPC). Without one the backend counts the
   * failure as neither handled nor unhandled - its aggregates bucket by status
   * code alone - so a failing message pattern reports zero errors of either
   * kind.
   */
  errorStatusCode?: number;
};

/**
 * An error the business logic did not model. `IntrinsicException` is what Nest
 * itself uses to tell a deliberately raised failure from a leaked one.
 */
const UNHANDLED_ERROR_STATUS_CODE = 500;

/**
 * A failure the handler raised on purpose. 4xx is what the backend's aggregates
 * count as handled; the exact code only matters when the exception carries one.
 */
const HANDLED_ERROR_STATUS_CODE = 400;

export class OperationTraceRegistry {
  private readonly traceSnapshots: Map<TraceId, SnapshotWithSignal> = new Map();
  private readonly callerIdsByTraceId: Map<
    TraceId,
    Map<string, OngoingTraceEventNode>
  > = new Map();
  private readonly logger = new Logger(OperationTraceRegistry.name);
  /**
   * An application started without `instrument` fails this way on *every*
   * request, and the guidance below is long enough that repeating it verbatim
   * would bury everything else in the log. Full text once, one line after.
   */
  private hasReportedMissingInstrumentation = false;

  constructor(
    private readonly als: AsyncLocalStorage<
      Map<KeyOf<{ [CALLER_METADATA_KEY]: string }>, unknown>
    >,
    private readonly sourceContext: CreateObserveModuleOptions["sourceContext"] = true,
  ) {}

  /**
   * Builds the error payload attached to a span or snapshot, including the source
   * around each in-app frame when source context is enabled.
   */
  private toErrorPayload(error: Error | string | object) {
    const payload =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error), stack: undefined };

    const result: {
      cls?: string;
      message: string;
      stack?: string;
      codeFrames?: CodeFrame[];
      tags?: Record<string, string | number | boolean>;
    } = payload;

    if (typeof error?.constructor === "function") {
      result.cls = error.constructor.name;
    }

    if (this.sourceContext !== false) {
      const settings = this.sourceContext === true ? {} : this.sourceContext;
      const codeFrames = collectCodeFrames(payload.stack, settings ?? {});
      if (codeFrames) {
        result.codeFrames = codeFrames;
      }
    }

    return result;
  }

  startTrace(
    traceId: TraceId,
    data:
      | Omit<
          RequestSnapshot,
          "traces" | "startTimestamp" | "calledAt" | "traceId"
        >
      | Omit<JobSnapshot, "duration">,
  ): void {
    if (this.traceSnapshots.has(traceId)) {
      this.logger.warn(
        `Trace already started for traceId: "${traceId}". Overwriting existing trace.`,
      );
      this.traceSnapshots.delete(traceId);
      this.callerIdsByTraceId.delete(traceId);
    }

    const snapshot: SnapshotWithSignal = {
      ...data,
      traceId,
      calledAt: new Date().toISOString(),
      startTimestamp: performance.now(),
      traces: [],
      refsCounter: 0,
      refsMarkedAsComplete: 0,
    };
    this.traceSnapshots.set(traceId, snapshot);
  }

  endTrace(traceId: string): void;
  endTrace(
    traceId: string,
    opts?: { statusCode?: number; userId?: string },
  ): void;
  endTrace(traceId: string, opts?: { status?: JobSnapshot["status"] }): void;
  endTrace(
    traceId: string,
    opts:
      | { statusCode?: number; userId?: string }
      | { status?: JobSnapshot["status"] } = {},
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      return;
    }

    if (snapshot.traces.length === 0) {
      if ("operationId" in snapshot) {
        // An operationId means a handler ran, and zero traces means nothing
        // recorded a span for it. Both at once has one cause: the instance
        // decorator never wrapped the providers, because `instrument` never
        // reached NestFactory.
        this.reportMissingInstrumentation(snapshot);
        this.traceSnapshots.delete(traceId);
        return;
      }

      // Ignore snapshots that have no traces as that means
      // the request didnt even have a handler in the first place
      this.traceSnapshots.delete(traceId);
      return;
    }
    snapshot.duration = performance.now() - snapshot.startTimestamp;

    const reportedStatusCode =
      "statusCode" in opts && typeof opts.statusCode === "number"
        ? opts.statusCode
        : undefined;
    const errorStatusCode =
      "protocol" in snapshot ? snapshot.errorStatusCode : undefined;

    // A root span that threw outranks a success status code reported by the
    // transport. Two cases need this. Transports that carry no status code of
    // their own (RPC, gRPC) end their trace without one at all, and the backend
    // buckets errors by status code alone - so a failing message pattern would
    // otherwise report zero handled *and* zero unhandled errors. GraphQL is the
    // sharper case: it answers 200 even when the resolver threw, reporting the
    // error in the body, so trusting the transport would give a service with a
    // failing resolver a flat zero error rate. 500 marks the failure as
    // unhandled, 4xx as deliberate.
    const statusCode =
      errorStatusCode !== undefined &&
      (reportedStatusCode === undefined || reportedStatusCode < 400)
        ? errorStatusCode
        : reportedStatusCode;

    if (typeof statusCode === "number") {
      this.setStatusCode(snapshot, statusCode);
    }

    if ("status" in opts && typeof opts.status === "string") {
      const jobSnapshot = snapshot as JobSnapshot;
      jobSnapshot.status = opts.status;
    }

    if ("userId" in opts && typeof opts.userId !== "undefined") {
      const requestSnapshot = snapshot as RequestSnapshot;
      requestSnapshot.userId = String(opts.userId);
    }

    delete snapshot.startTimestamp; // Clean up to avoid confusion

    if (snapshot.traces && snapshot.traces.length > 0) {
      // Iterate through root traces to check if any have errors
      for (const trace of snapshot.traces) {
        if ("error" in trace && trace.error) {
          // If any root trace has an error, we mark the entire snapshot as having an error
          if (typeof trace.error === "object") {
            snapshot.error = trace.error;
          }
          break; // No need to check further once an error is found
        }
      }
    }
  }

  /**
   * Reports a handler that ran without instrumentation. The example is spelled
   * out because the fix is never in the file the developer is looking at: the
   * symptom appears in a controller, the cause is in `main.ts`.
   */
  private reportMissingInstrumentation(snapshot: RequestSnapshot): void {
    const method = snapshot.attributes?.method;
    const operation = method
      ? `${method} ${snapshot.operationId}`
      : snapshot.operationId;

    if (this.hasReportedMissingInstrumentation) {
      this.logger.error(
        `Operation "${operation}" produced no spans - the "instrument" option is still missing from NestFactory (traceId: "${snapshot.traceId}").`,
      );
      return;
    }
    this.hasReportedMissingInstrumentation = true;

    this.logger.error(
      [
        `Operation "${operation}" produced no spans, so this request is missing from your traces (traceId: "${snapshot.traceId}").`,
        `The handler ran, but none of its providers were instrumented - which happens when the "instrument" option never reaches NestFactory.`,
        ``,
        `Pass the instrument that createObserveModule() returns next to the module it belongs to:`,
        ``,
        `  // app.module.ts`,
        `  export const { ObserveModule, ObserveInstrument } = createObserveModule();`,
        ``,
        `  // main.ts`,
        `  const app = await NestFactory.create(AppModule, {`,
        `    instrument: ObserveInstrument,`,
        `  });`,
        ``,
        `NestFactory.createMicroservice() accepts the same option. Later occurrences of this error are logged on a single line.`,
      ].join("\n"),
    );
  }

  /**
   * Classifies a failed operation for transports that report no status code.
   *
   * `IntrinsicException` is the line Nest itself draws between a failure the
   * handler raised on purpose and one that leaked out of it, so it is the line
   * used here: intrinsic errors land in the handled bucket, everything else in
   * the unhandled one. An `HttpException` keeps its own code when that code
   * already reads as handled - a 5xx one would otherwise be counted against the
   * handler that deliberately raised it.
   */
  private toErrorStatusCode(error: Error | string | object): number {
    if (!(error instanceof IntrinsicException)) {
      return UNHANDLED_ERROR_STATUS_CODE;
    }

    const status = (error as { getStatus?: () => unknown }).getStatus?.();
    if (typeof status === "number" && status >= 400 && status < 500) {
      return status;
    }
    return HANDLED_ERROR_STATUS_CODE;
  }

  private setStatusCode(
    snapshot: RequestSnapshot | JobSnapshot,
    statusCode: number,
  ): void {
    const requestSnapshot = snapshot as RequestSnapshot;
    if (!requestSnapshot.attributes) {
      requestSnapshot.attributes = {};
    }
    requestSnapshot.attributes.statusCode = statusCode;
  }

  internalStartTraceStep(
    traceId: TraceId,
    className: string,
    methodKey: string,
    callerId: string | undefined,
  ): string {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      return;
    }
    snapshot.refsCounter += 1;

    const newNodeId = randomUUID();
    const startTime = performance.now();

    // Records which span owns the thread from here. A no-op unless continuous
    // profiling is on, and the only way profile samples can be attributed to a
    // span: V8 hands back a batch afterwards, so there is nothing to label at
    // the moment a sample fires.
    activeSliceRecorder()?.enter(traceId, newNodeId, startTime);
    const newNode: OngoingTraceEventNode = {
      origin: "auto",
      type: "start",
      className,
      methodKey,
      startTime,
      startOffset: this.toStartOffset(snapshot, startTime),
      children: [],
      // The caller id doubles as the span id rather than a second identifier
      // being minted for it. That is what lets a log line name the span it was
      // written inside: the forwarder reads this exact value out of the async
      // store (CALLER_METADATA_KEY), so the two sides agree by construction
      // instead of by a timing heuristic. It costs a uuid per span on the wire.
      spanId: newNodeId,
    };

    let refsByCaller = this.callerIdsByTraceId.get(traceId)!;
    if (callerId) {
      const caller = refsByCaller.get(callerId)!;
      caller.children.push(newNode);
      newNode.parent = caller;
    } else {
      // No caller means insert trace at the root level
      snapshot.traces.push(newNode);
    }

    if (!refsByCaller) {
      refsByCaller = new Map<string, OngoingTraceEventNode>();
      this.callerIdsByTraceId.set(traceId, refsByCaller);
    }
    refsByCaller.set(newNodeId, newNode);

    return newNodeId;
  }

  internalEndTraceStep(
    traceId: TraceId,
    spanId: string,
    className: string,
    methodKey: string,
    callerId: string,
    error?: Error | string | object,
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      this.logger.error(
        `No snapshot found for traceId: "${traceId}". Cannot end trace step for "${className}#${methodKey}".`,
      );
      return;
    }
    snapshot.refsMarkedAsComplete += 1;
    activeSliceRecorder()?.exit(callerId);

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    if (!refsByCaller) {
      this.logger.warn(
        `No ongoing ref map found for the "${spanId}" span. Some of your async operations were not awaited and the outer span ended before the inner one. Check your "${className}#${methodKey}" method. Ignore if this is the desired behavior.`,
      );
      return;
    }
    const cursor: OngoingTraceEventNode = refsByCaller.get(callerId);
    if (!cursor) {
      this.logger.warn(
        `No ongoing trace found for the "${spanId}" span. Some of your async operations were not awaited and the outer span ended before the inner one. Check your "${className}#${methodKey}" method. Ignore if this is the desired behavior.`,
      );
      return;
    }

    const duration = performance.now() - cursor.startTime;

    delete cursor.type; // Remove the 'type' property as the node is now complete
    delete cursor.startTime; // Remove the 'startTime' property as the duration is now set
    const parent = cursor.parent;
    delete cursor.parent; // Remove the parent reference from the cursor as complete nodes should not have a parent reference

    // Remove tags if empty
    if (Object.keys(cursor.tags || {}).length === 0) {
      delete cursor.tags;
    }

    // Clean up children array if it is empty
    if (cursor.children.length === 0) {
      delete cursor.children;
    }

    const activeTrace: CompleteTraceEventNode =
      cursor as unknown as CompleteTraceEventNode;

    activeTrace.duration = duration;

    if (error && !activeTrace.error) {
      const isRootSpan = !parent;
      if (isRootSpan) {
        // Only a root span decides this: an error thrown deeper down may well
        // have been caught and handled by its caller, in which case the
        // operation did not fail at all.
        snapshot.errorStatusCode = this.toErrorStatusCode(error);

        // If this is the root span, we can directly set the error on the snapshot
        // if it's a non-intrinsic error
        if (typeof error === "object") {
          activeTrace.error = this.toErrorPayload(error);
        } else {
          activeTrace.error = true;
        }
      } else {
        activeTrace.error = true;
      }
    }
  }

  addRouteMetadataToTrace(
    requestId: string,
    requestMethod: RequestMethod,
    path: string,
  ): void {
    const snapshot = this.traceSnapshots.get(requestId) as RequestSnapshot;
    if (!snapshot) {
      return;
    }
    snapshot.operationId = path;
  }

  /**
   * Labels a trace with the GraphQL root field being resolved.
   *
   * Only the first root field of a request wins. A document may select several
   * (`{ orders { id } customers { id } }`), and an operation id that changed
   * with the last field to finish would scatter one endpoint's traffic across
   * several rows; first-one-wins is arbitrary but stable. It also means a
   * `/graphql` route label - were one ever set - is not overwritten silently.
   */
  addGraphQLMetadataToTrace(
    traceId: TraceId,
    metadata: {
      operationId: string;
      tags?: Record<string, string | number | boolean>;
      attributes?: RequestSnapshot["attributes"];
    },
  ): void {
    const snapshot = this.traceSnapshots.get(traceId) as RequestSnapshot;
    if (!snapshot) {
      return;
    }
    snapshot.operationId ??= metadata.operationId;
    if (metadata.tags) {
      snapshot.tags = { ...snapshot.tags, ...metadata.tags };
    }
    if (metadata.attributes) {
      // Merged over whatever the transport recorded. Method and status code
      // survive; `originalUrl` is deliberately replaced - the GraphQL document
      // is the informative value, the shared mount path is not.
      snapshot.attributes = { ...snapshot.attributes, ...metadata.attributes };
    }
  }

  /**
   * Offset of a span's start from the start of its trace root, in milliseconds.
   *
   * Captured when the span opens rather than when it closes: `startTimestamp` is
   * deleted once the trace ends, and a span that outlives its trace (an un-awaited
   * async call) would otherwise lose its offset entirely.
   */
  private toStartOffset(
    snapshot: SnapshotWithSignal | undefined,
    startTime: number,
  ): number | undefined {
    if (typeof snapshot?.startTimestamp !== "number") {
      return undefined;
    }
    return startTime - snapshot.startTimestamp;
  }

  captureError(
    traceId: string,
    callerId: string,
    error: Error | string,
    tags: Record<string, string | number | boolean>,
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      this.logger.warn(
        `No request snapshot found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    if (!snapshot.traces || snapshot.traces.length === 0) {
      this.logger.warn(
        `No traces found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    const targetSpan = refsByCaller.get(callerId);
    if (!targetSpan) {
      this.logger.warn(
        `No active span found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    if (!targetSpan.tags) {
      targetSpan.tags = {};
    }

    // Merge tags
    Object.assign(targetSpan.tags, tags);

    targetSpan.error = this.toErrorPayload(error);
  }

  /**
   * Drops a trace that will never be plucked, freeing both maps.
   *
   * The HTTP agent calls this when a client aborts: the adapter's response
   * hook rides `finish`, which an aborted response never emits, so without
   * this the snapshot - spans, error payloads, code frames - would stay
   * registered for the life of the process. Nothing is reported; a trace with
   * no response has no status code to file it under.
   */
  abandonTrace(traceId: TraceId): void {
    this.callerIdsByTraceId.delete(traceId);
    this.traceSnapshots.delete(traceId);
  }

  async pluckSnapshot(
    traceId: string,
  ): Promise<RequestSnapshot | JobSnapshot | undefined> {
    if (this.traceSnapshots.has(traceId)) {
      const snapshot = this.traceSnapshots.get(traceId);
      const cleanup = () => {
        this.callerIdsByTraceId.delete(traceId);
        this.traceSnapshots.delete(traceId);
      };

      // Ensure snapshot is complete by checking refsCounter vs refsMarkedAsComplete
      if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
        await new Promise((resolve) =>
          setTimeout(resolve, SNAPSHOT_COMPLETION_TIMEOUT_MS),
        );
        if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
          cleanup();
          return undefined;
        }
      }
      cleanup();

      delete snapshot.refsCounter;
      delete snapshot.refsMarkedAsComplete;
      delete snapshot.errorStatusCode;
      return snapshot;
    }
    return undefined;
  }

  getActiveSpan(
    traceId: string,
    callerId: string,
  ): OngoingTraceEventNode | undefined {
    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    if (!refsByCaller) {
      return undefined;
    }
    const activeSpan = refsByCaller.get(callerId);
    return activeSpan;
  }

  async createManualSpan(
    traceId: string,
    callerId: string,
    name: string,
    spanFunction: (span: TraceSpanDelegate) => any,
  ) {
    // await new Promise((resolve) => setImmediate(resolve));

    const activeSpan = this.getActiveSpan(traceId, callerId);
    if (!activeSpan) {
      return spanFunction(new TraceSpanDelegate("", name, {}));
    }

    const snapshot = this.traceSnapshots.get(traceId);
    // Book the span in the same ledger auto spans use. Completion goes through
    // internalEndTraceStep, which increments refsMarkedAsComplete - without
    // the matching increment here, every completed manual span pushed the
    // completed count one ahead, and a trace holding one leaked auto span plus
    // one manual span read as complete: pluckSnapshot then shipped a
    // half-built tree whose ongoing node still held its circular `parent`
    // reference, and JSON.stringify threw away the whole flush window.
    if (snapshot) {
      snapshot.refsCounter += 1;
    }

    const newNodeId = randomUUID();
    const startTime = performance.now();

    // Same as internalStartTraceStep: without an enter, the exit issued on
    // completion no-ops and the span's execution time is silently attributed
    // to its parent - profile correlation for manual spans found nothing.
    activeSliceRecorder()?.enter(traceId, newNodeId, startTime);
    const manualSpan: OngoingTraceEventNode = {
      // Same identity rule as auto spans: the span id *is* the caller id it is
      // registered under, so a log line written inside this span carries an id
      // that resolves back to this node.
      spanId: newNodeId,
      name,
      origin: "manual",
      type: "start",
      className: activeSpan.className,
      methodKey: activeSpan.methodKey,
      startTime,
      startOffset: this.toStartOffset(snapshot, startTime),
      children: [],
      parent: activeSpan,
    };
    activeSpan.children.push(manualSpan);

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    refsByCaller.set(newNodeId, manualSpan);

    const onResponse = (res: unknown) => {
      // setImmediate
      this.internalEndTraceStep(
        traceId,
        manualSpan.spanId,
        manualSpan.className,
        manualSpan.methodKey,
        newNodeId,
      );
      return res;
    };
    const onError = (err: unknown) => {
      // setTimeout(
      //   () =>
      this.internalEndTraceStep(
        traceId,
        manualSpan.spanId,
        manualSpan.className,
        manualSpan.methodKey,
        newNodeId,
        err as Error | string | object,
      );
      //   0,
      // );
      // Re-throw the error to maintain original behavior
      throw err;
    };

    const tags = {} as Record<string, string | number | boolean>;
    const delegate = new TraceSpanDelegate(
      manualSpan.spanId,
      manualSpan.name,
      tags,
    );
    manualSpan.tags = tags;
    const store = this.als.getStore();
    return this.als.run(
      new Map([...store.entries(), [CALLER_METADATA_KEY, newNodeId]]),
      () => {
        try {
          const result = spanFunction(delegate);
          if (result instanceof Promise) {
            return result.then(onResponse).catch(onError);
          }
          return onResponse(result);
        } catch (err) {
          onError(err);

          // Re-throw to maintain original behavior
          throw err;
        }
      },
    );
  }
}
