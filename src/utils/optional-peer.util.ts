import { createRequire } from "module";

/**
 * What loading an optional peer produced.
 *
 * `installed: false` is the normal case for a service that does not use the
 * feature - not a misconfiguration, and callers should stay silent about it.
 * `installed: true` with no `module` means the package is present but the
 * requested entry could not be loaded; `error` carries the cause so the
 * caller can say something truthful instead of guessing.
 */
export type OptionalPeerResult<T> =
  | { installed: false }
  | { installed: true; module: T | undefined; error?: unknown };

/**
 * Loads an optional peer dependency without a static import, so a service
 * that does not use the feature need not install the package.
 *
 * Synchronous on purpose: every caller patches or subscribes during provider
 * instantiation or `onModuleInit`, strictly before the peer's own lifecycle
 * runs, and a dynamic `import()` would resolve too late. All current peers
 * ship CommonJS, so `require` can load them.
 *
 * The package's presence is probed with `require.resolve(packageName)` before
 * `specifier` (which may be a deep path into the package) is required, so
 * "not installed" is kept apart from "installed but broken or reshaped".
 * `createRequire` itself failing - a CJS bundle that erased `import.meta.url`,
 * say - is treated as "not installed": with no resolver there is nothing to
 * load, and crashing the constructor would defeat the point of the peer being
 * optional.
 */
/** Names a load failure for a log line: the message for an `Error`, `String` otherwise. */
export function describePeerLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadOptionalPeer<T>(
  packageName: string,
  specifier: string = packageName,
): OptionalPeerResult<T> {
  let require: ReturnType<typeof createRequire>;
  try {
    require = createRequire(import.meta.url);
    require.resolve(packageName);
  } catch {
    return { installed: false };
  }
  try {
    return { installed: true, module: require(specifier) as T };
  } catch (error) {
    return { installed: true, module: undefined, error };
  }
}
