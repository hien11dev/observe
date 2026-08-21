import { Worker } from "worker_threads";

/**
 * The lock protocol the agent's two threads share.
 *
 * The main thread (`ObserveAgentSharedBuffer`) writes the encoded batch into a
 * `SharedArrayBuffer`; the detached worker reads it out and posts it. They
 * coordinate through one 32-bit word at the head of that buffer, and the tests
 * here are about that word rather than about either side's code - both were
 * wrong in ways no single-threaded test could see.
 */
describe("shared buffer lock protocol", () => {
  const lockOf = () => new Int32Array(new SharedArrayBuffer(4), 0, 1);

  describe("acquiring", () => {
    it("refuses when the word is already held", () => {
      const lock = lockOf();
      Atomics.store(lock, 0, 1);

      expect(Atomics.compareExchange(lock, 0, 0, 1)).not.toEqual(0);
    });

    it("takes it when free, and reports that it was free", () => {
      const lock = lockOf();

      expect(Atomics.compareExchange(lock, 0, 0, 1)).toEqual(0);
      expect(Atomics.load(lock, 0)).toEqual(1);
    });

    it("cannot be expressed with `store`, which is what the worker used", () => {
      const lock = lockOf();
      Atomics.store(lock, 0, 1);

      // `Atomics.store` returns the value it stored, so `if (!acquireLock())`
      // tested a constant 1: the worker's guard never fired and it read the
      // buffer while the main thread was writing it.
      expect(Atomics.store(lock, 0, 1)).toEqual(1);
      expect(!Atomics.store(lock, 0, 1)).toBe(false);
    });
  });

  describe("waiting", () => {
    it("blocks while the lock is held", () => {
      const lock = lockOf();
      Atomics.store(lock, 0, 1);

      expect(Atomics.wait(lock, 0, 1, 20)).toEqual("timed-out");
    });

    it("returns at once when the lock is free", () => {
      const lock = lockOf();

      expect(Atomics.wait(lock, 0, 1, 20)).toEqual("not-equal");
    });

    it("waiting on 0 inverts both, which is what the worker did", () => {
      const lock = lockOf();

      // Free: parked, despite there being nothing to wait for.
      expect(Atomics.wait(lock, 0, 0, 20)).toEqual("timed-out");

      // Held: returned immediately, so the surrounding `while` spun hot for as
      // long as the main thread held the lock.
      Atomics.store(lock, 0, 1);
      expect(Atomics.wait(lock, 0, 0, 20)).toEqual("not-equal");
    });
  });

  /**
   * The property that matters: two threads contending must never both be inside
   * the critical section. `occupancy` is incremented on entry and decremented on
   * exit, so any reading above 1 is an interleaving - which is a torn payload in
   * production.
   *
   * The section is held for a spin rather than exited immediately, and that is
   * the point: with a section only a few atomic operations long, the broken
   * protocol this replaced passed cleanly - the window to interleave was too
   * narrow to land in. Held for 200us, the old idiom produced violations on
   * every run (35 on the machine this was written on) and the current one
   * produces none. A test that cannot fail against the bug it describes is
   * decoration.
   */
  it("keeps two real threads out of each other's critical section", async () => {
    const shared = new SharedArrayBuffer(12);
    const words = new Int32Array(shared);
    const LOCK = 0;
    const OCCUPANCY = 1;
    const VIOLATIONS = 2;

    const contend = `
      const { parentPort, workerData } = require("worker_threads");
      const words = new Int32Array(workerData.shared);
      const spin = (us) => {
        const end = process.hrtime.bigint() + BigInt(us * 1000);
        while (process.hrtime.bigint() < end);
      };
      for (let i = 0; i < 300; i++) {
        while (Atomics.compareExchange(words, ${LOCK}, 0, 1) !== 0) {
          Atomics.wait(words, ${LOCK}, 1, 5);
        }
        if (Atomics.add(words, ${OCCUPANCY}, 1) !== 0) {
          Atomics.add(words, ${VIOLATIONS}, 1);
        }
        spin(200);
        Atomics.sub(words, ${OCCUPANCY}, 1);
        Atomics.store(words, ${LOCK}, 0);
        Atomics.notify(words, ${LOCK});
      }
      parentPort.postMessage("done");
    `;

    const workers = [0, 1].map(
      () => new Worker(contend, { eval: true, workerData: { shared } }),
    );

    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.once("message", () => resolve());
            worker.once("error", reject);
          }),
      ),
    );
    await Promise.all(workers.map((worker) => worker.terminate()));

    expect(Atomics.load(words, VIOLATIONS)).toEqual(0);
    // Both threads finished and left the lock free.
    expect(Atomics.load(words, LOCK)).toEqual(0);
    expect(Atomics.load(words, OCCUPANCY)).toEqual(0);
  }, 30_000);
});
