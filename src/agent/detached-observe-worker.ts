export const detachedObserveWorker = () => {
  // This function body is stringified via .toString() and executed as a
  // standalone worker script, so it can't use static ES imports and must
  // require() its dependencies at runtime instead.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parentPort, workerData } = require("worker_threads");
  const zlib = require("zlib");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // `workerData` carries the shared buffer plus the collector config: the
  // stringified function has no access to this module's configuration, so
  // everything it needs must arrive here.
  const { sharedBuffer, config } = workerData;

  const buffer = new Uint8Array(sharedBuffer);
  const lock = new Int32Array(sharedBuffer, 0, 1);
  const view = new DataView(sharedBuffer, 4, 4);
  const decoder = new TextDecoder();

  const telemetryUrl = `${config.endpoint}/applications/telemetry`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
  };
  // Omitted rather than sent empty when unconfigured: a collector in
  // placeholder mode accepts an unauthenticated batch, and blank credentials
  // would be a 401 instead.
  if (config.appKey && config.appSecret) {
    headers["x-api-key"] = config.appKey;
    headers["x-api-secret"] = config.appSecret;
  }

  /**
   * Whether the collector has already refused these credentials.
   *
   * Rejected credentials do not recover on their own: the values arrive in the
   * environment and are read once at start-up, so nothing short of a restart
   * can change the answer. Reporting it on every flush therefore adds no
   * information and costs a line every few seconds - 535 identical errors in
   * half an hour, in the run that prompted this - which buries whatever else
   * the service was trying to say.
   *
   * Said once, in full, and then only counted. Flushing continues either way:
   * the batch is dropped rather than queued, so a fixed deployment starts
   * reporting again without anything to drain.
   */
  let authRejections = 0;

  /**
   * How many rejected batches between reminders. At the default five-second
   * flush this is roughly hourly - often enough that a long-running process
   * silently dropping telemetry is still visible in a day's logs, rare enough
   * that it never competes with anything.
   */
  const AUTH_REJECTION_REPORT_EVERY = 720;

  /**
   * How long to block waiting for the main thread to release the lock, and how
   * long to sleep when the buffer holds nothing.
   *
   * Both exist to keep this thread off the CPU while idle. The wait carries a
   * timeout rather than blocking forever so a notification that arrives between
   * the load and the wait cannot park this thread indefinitely; the sleep is
   * what stops an empty buffer becoming a spin loop, and its length only adds
   * latency to a flush the main thread performs on a timer anyway.
   */
  const LOCK_WAIT_MS = 100;
  const IDLE_SLEEP_MS = 50;

  /**
   * Takes the lock if it is free.
   *
   * One `compareExchange` rather than a read followed by a write: the main
   * thread contends for this same word, and between a load saying the lock was
   * free and a store taking it, the other side can take it too - leaving both
   * threads believing they hold it, one writing the buffer while the other
   * reads it. `compareExchange` stores only if the word is still 0 and returns
   * what was there, so the check and the take are one indivisible step.
   */
  const acquireLock = () => Atomics.compareExchange(lock, 0, 0, 1) === 0;

  /**
   * Blocks while the main thread holds the lock.
   *
   * `Atomics.wait` blocks while the word *equals* the expected value, so the
   * expected value here is 1 - locked - and the load first avoids the syscall
   * entirely when the lock is already free.
   */
  const waitWhileLocked = () => {
    if (Atomics.load(lock, 0) !== 0) {
      Atomics.wait(lock, 0, 1, LOCK_WAIT_MS);
    }
  };

  const releaseLock = () => {
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0);
  };
  const clearBuffer = () => view.setUint32(0, 0); // Reset length to 0
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Sends one batch, if there is one to send.
   *
   * Returns whether anything was sent, so the loop below knows to come back
   * immediately or to sleep first.
   */
  const sendInstrumentationJsonData = async () => {
    waitWhileLocked();

    if (!acquireLock()) {
      // Lost the race to the main thread, which is flushing. Nothing to report
      // - this is the ordinary contention the lock exists for - so the loop
      // simply comes back to it.
      return false;
    }

    try {
      const jsonLength = view.getUint32(0);
      if (jsonLength === 0) {
        // `finally` releases the lock on this path like every other.
        return false;
      }

      // Skip the first 4 bytes (lock) and the next 4 bytes (length)
      const jsonBytes = buffer.slice(8, 8 + jsonLength);
      const jsonStr = decoder.decode(jsonBytes);

      const compressed = await new Promise((resolve, reject) =>
        zlib.gzip(jsonStr, (err: Error | null, compressed: Buffer) => {
          if (err) {
            reject(err);
          } else {
            resolve(compressed);
          }
        }),
      );

      const response = await fetch(telemetryUrl, {
        method: "POST",
        headers,
        body: compressed as Buffer,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          authRejections += 1;

          // Said plainly, and once. The batch is well-formed and the
          // credentials are not accepted for this application; left as a
          // generic transport failure this reads as a network problem, and the
          // fix - appKey and appSecret - is nowhere in the message.
          if (authRejections === 1) {
            parentPort.postMessage(
              `Error: Telemetry rejected (${response.status}). Check that appKey and appSecret are valid; ` +
                `the application is taken from the key. Credentials are read once at start-up, so this ` +
                `will not recover without a restart - further rejections are counted, not logged.`,
            );
          } else if (authRejections % AUTH_REJECTION_REPORT_EVERY === 0) {
            // A periodic reminder, rare enough not to bury anything. Without
            // it a process that has been dropping telemetry for a day looks
            // exactly like one that is healthy.
            parentPort.postMessage(
              `Error: Telemetry still rejected (${response.status}); ${authRejections} batches dropped since start-up.`,
            );
          }
          return true;
        }
        // Read as text, defensively: an error body is not guaranteed to be
        // JSON, and a parse failure here must not fall through to the catch
        // below and report a reachable collector as unreachable.
        const errorBody = await response.text().catch(() => "");
        parentPort.postMessage(
          `Error: Failed to send data. ${response.statusText} (${response.status})` +
            (errorBody ? ` - ${errorBody.slice(0, 500)}` : ""),
        );
        return true;
      }

      parentPort.postMessage(
        "Tracing and instrumentation data sent successfully",
      );
      return true;
    } catch (err) {
      // `fetch` reports every transport failure as the same opaque "fetch
      // failed", and puts the reason - ECONNREFUSED, ENOTFOUND, a TLS error -
      // on `err.cause`. Reporting only `err.message` therefore tells the
      // operator nothing: not what went wrong, and not which URL was tried.
      // The 401/403 branch above already names what to check; this does the
      // same for the case where the collector was never reached.
      const cause = (err as { cause?: { code?: string; message?: string } })
        ?.cause;
      const reason = cause?.code ?? cause?.message;

      parentPort.postMessage(
        `Error: Could not reach the collector at ${telemetryUrl}` +
          (reason ? ` (${reason})` : "") +
          `. Check that it is running and that \`endpoint\` points at it.`,
      );
      // The batch is discarded rather than retried - `clearBuffer` below -
      // which is the right call for a fixed-size buffer the application is
      // still writing into: holding it for a retry would block every batch
      // behind an unreachable collector.
      return true;
    } finally {
      clearBuffer();
      releaseLock();
    }
  };

  /**
   * The worker's main loop.
   *
   * A flat loop, so the worker's liveness never depends on a recursive call.
   * Sleeping when there was nothing to send is what keeps an idle process off
   * the CPU: without it an empty buffer would be acquired, found empty and
   * released as fast as the thread can go.
   */
  const run = async () => {
    parentPort.postMessage("Ready to process instrumentation data");

    for (;;) {
      const sent = await sendInstrumentationJsonData();
      if (!sent) {
        await sleep(IDLE_SLEEP_MS);
      }
    }
  };

  run();
};
