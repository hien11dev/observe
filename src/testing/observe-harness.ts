import { INestApplication, INestMicroservice } from "@nestjs/common";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";

/**
 * Module options every protocol suite boots with.
 *
 * Credentials are required by the options contract but never used here:
 * snapshots are intercepted before they reach the buffer, so the worker finds
 * nothing to flush and never contacts a collector. The long flush interval is
 * belt and braces - it guarantees the timer cannot fire mid-suite even if a
 * future change starts letting data through.
 */
export function testObserveOptions(
  overrides: Partial<ObserveOptions> = {},
): ObserveOptions {
  return {
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    serviceId: "00000000-0000-4000-8000-000000000000",
    runtimeMetrics: false,
    forwardLogs: false,
    flushInterval: 60_000,
    ...overrides,
  } as ObserveOptions;
}

/**
 * Shared plumbing for the protocol integration suites.
 *
 * `ObserveModule` is destined to be its own npm package, so these suites boot
 * real Nest applications and drive real traffic through them rather than
 * calling the agents directly - the thing worth protecting is that the module
 * still attaches to Nest's hooks, and only a real app exercises that.
 *
 * Snapshots are captured at `ObserveAgentSharedBuffer.insertRequestSnapshot`,
 * which is where every protocol converges once a trace completes. Asserting
 * there rather than on the encoded payload keeps the tests about *what was
 * collected* instead of how it is serialised.
 */
export class CollectedSnapshots {
  readonly items: RequestSnapshot[] = [];

  get operationIds(): Array<string | undefined> {
    return this.items.map((snapshot) => snapshot.operationId);
  }

  find(operationId: string): RequestSnapshot | undefined {
    return this.items.find((snapshot) => snapshot.operationId === operationId);
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Intercepts snapshots on their way into the shared buffer.
 *
 * Spied rather than read back out of the buffer: the buffer encodes into a
 * `SharedArrayBuffer` and is drained by a worker thread on a timer, so reading
 * it would make every assertion a race.
 */
export function collectSnapshots(
  app: INestApplication | INestMicroservice,
): CollectedSnapshots {
  const collected = new CollectedSnapshots();
  const buffer = app.get(ObserveAgentSharedBuffer, { strict: false });

  vi.spyOn(buffer, "insertRequestSnapshot").mockImplementation(
    (snapshot: RequestSnapshot) => {
      collected.items.push(snapshot);
    },
  );

  return collected;
}

/**
 * Waits for a snapshot to arrive, or gives up.
 *
 * Every protocol finishes its trace asynchronously - the HTTP agent on the
 * response hook, gRPC behind a `setTimeout(0)` - so a bare assertion after
 * `await request(...)` is a race the test would lose intermittently. Polling to
 * a deadline keeps the suites honest about that without hard-coded sleeps.
 */
export async function waitForSnapshot(
  collected: CollectedSnapshots,
  predicate: (snapshot: RequestSnapshot) => boolean,
  timeoutMs = 3000,
): Promise<RequestSnapshot> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = collected.items.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `No matching snapshot within ${timeoutMs}ms. Collected: ${JSON.stringify(
      collected.items.map((s) => ({
        protocol: s.protocol,
        operationId: s.operationId,
      })),
    )}`,
  );
}

/** A free port, so parallel suites and a busy machine cannot collide. */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
