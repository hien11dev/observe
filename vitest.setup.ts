import "reflect-metadata";

/**
 * Vitest installs an `Error.prepareStackTrace` hook that re-renders every stack
 * from raw CallSites. That rendering takes a frame's name from the function's
 * internal name, which silently discards the labels this package stamps onto
 * its wrapper frames with `Object.defineProperty(fn, "name", ...)`.
 *
 * Frame naming is behaviour here, not cosmetics - the instrumentation relabels
 * `Proxy.<method>` frames, the profiler folds stacks into flame data, and the
 * trace registry attributes errors by frame. Those have to be asserted against
 * the stack V8 actually produces in production, so the hook is removed.
 *
 * The cost is that Vitest's own failure output reports positions in the
 * transformed source rather than the `.ts`; SWC strips types line-for-line, so
 * the line numbers still line up.
 */
Error.prepareStackTrace =
  undefined as unknown as typeof Error.prepareStackTrace;
