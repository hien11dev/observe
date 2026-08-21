import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The package is loaded synchronously and only on demand, which ESM `import()`
 * cannot do. A CommonJS require bound to this module's URL keeps that lazy,
 * throw-free behaviour intact.
 */
const require = createRequire(import.meta.url);

/**
 * A stack frame position mapped back to the source it was compiled from.
 */
export interface OriginalPosition {
  /** Absolute path of the original file, or the map-relative path if it cannot be resolved. */
  file: string;
  /** 1-based line in the original file. */
  line: number;
  /** Original source text, when the map carries `sourcesContent`. */
  content?: string[];
}

const SOURCE_MAPPING_URL_PATTERN = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm;

const INLINE_MAP_PREFIX = "data:application/json";

interface LoadedMap {
  /** @jridgewell/trace-mapping TraceMap instance. */
  tracer: unknown;
  /** Directory the map lives in, for resolving relative `sources` entries. */
  mapDir: string;
}

/** Parsed maps by compiled-file path; null marks "looked, found none". */
const mapCache = new Map<string, LoadedMap | null>();

let traceMappingModule: {
  TraceMap: new (map: unknown) => unknown;
  originalPositionFor: (
    tracer: unknown,
    position: { line: number; column: number },
  ) => { source: string | null; line: number | null; column: number | null };
  sourceContentFor: (tracer: unknown, source: string) => string | null;
} | null = null;

let traceMappingLoadAttempted = false;

/**
 * Loaded on first use rather than at import time, so a process that never enables
 * source maps never pays for it - and a missing install degrades to raw frames
 * instead of taking the app down.
 */
function loadTraceMapping() {
  if (traceMappingLoadAttempted) {
    return traceMappingModule;
  }
  traceMappingLoadAttempted = true;
  try {
    traceMappingModule = require("@jridgewell/trace-mapping");
  } catch {
    traceMappingModule = null;
  }
  return traceMappingModule;
}

function readMapFor(file: string): LoadedMap | null {
  const traceMapping = loadTraceMapping();
  if (!traceMapping) {
    return null;
  }

  let compiled: string;
  try {
    compiled = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  // Last occurrence wins: a bundle can contain the string in its own payload.
  let url: string | undefined;
  for (const match of compiled.matchAll(SOURCE_MAPPING_URL_PATTERN)) {
    url = match[1];
  }
  if (!url) {
    return null;
  }

  let rawMap: string;
  let mapDir = dirname(file);
  try {
    if (url.startsWith(INLINE_MAP_PREFIX)) {
      const base64Marker = "base64,";
      const index = url.indexOf(base64Marker);
      rawMap =
        index === -1
          ? decodeURIComponent(url.slice(url.indexOf(",") + 1))
          : Buffer.from(
              url.slice(index + base64Marker.length),
              "base64",
            ).toString("utf8");
    } else {
      const mapPath = resolve(dirname(file), url);
      mapDir = dirname(mapPath);
      rawMap = readFileSync(mapPath, "utf8");
    }
  } catch {
    return null;
  }

  try {
    return {
      tracer: new traceMapping.TraceMap(JSON.parse(rawMap)),
      mapDir,
    };
  } catch {
    return null;
  }
}

function getMap(file: string): LoadedMap | null {
  if (mapCache.has(file)) {
    return mapCache.get(file)!;
  }
  const loaded = readMapFor(file);
  mapCache.set(file, loaded);
  return loaded;
}

/**
 * Maps a compiled frame position back to the original source.
 *
 * Returns undefined when there is no usable map, leaving the caller to fall back
 * to the compiled file - a degraded but still truthful result.
 */
export function resolveOriginalPosition(
  file: string,
  line: number,
  column: number,
): OriginalPosition | undefined {
  const traceMapping = loadTraceMapping();
  if (!traceMapping) {
    return undefined;
  }

  const map = getMap(file);
  if (!map) {
    return undefined;
  }

  const position = traceMapping.originalPositionFor(map.tracer, {
    line,
    // Stack columns are 1-based, source map columns are 0-based.
    column: Math.max(0, column - 1),
  });

  if (!position.source || position.line === null) {
    return undefined;
  }

  // `sourcesContent` is the reliable path: the original text is embedded in the
  // map, so it works even when the source tree is absent at runtime (a container
  // shipping only dist, for instance).
  const embedded = traceMapping.sourceContentFor(map.tracer, position.source);

  return {
    file: position.source.startsWith("/")
      ? position.source
      : resolve(map.mapDir, position.source),
    line: position.line,
    content: embedded ? embedded.split("\n") : undefined,
  };
}

/** Testing seam - the caches are process-lifetime otherwise. */
export function resetSourceMapCache(): void {
  mapCache.clear();
}
