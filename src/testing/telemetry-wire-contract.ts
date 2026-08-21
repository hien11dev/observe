/**
 * The shape the ingestion API accepts, declared here rather than imported from
 * the collector's DTOs.
 *
 * The encoders and the API agree on nothing but single-letter key names, so
 * something has to fail when they drift. That used to be the API's
 * `InsertTelemetryDataDto`, reached across the repo boundary - which meant this
 * package could not be built, tested or published on its own. The contract is
 * restated here instead: it is the SDK's copy of the agreement, and the thing
 * that has to be updated in lockstep when the API changes.
 *
 * Deliberately *not* generated from the encoders' key maps. A contract derived
 * from the code it checks asserts only that the code equals itself. Every key
 * below is written out by hand so that changing a key map breaks a test and
 * forces the API change to be made consciously.
 *
 * The clearest example is `st`: both snapshot encoders map `startTimestamp` to
 * it, and it is absent here on purpose. The API does not declare that field, it
 * validates with `forbidNonWhitelisted`, and what keeps it off the wire is
 * `OperationTraceRegistry.endTrace` deleting it before the encoder ever sees
 * the snapshot. A payload that still carries `st` is rejected with a 400, so
 * `validateTelemetryPayload(..., { forbidUnknown: true })` rejects it too.
 */

type FieldType = "string" | "number" | "boolean" | "object";

interface FieldSpec {
  /** Primitive type, or the type of each element for an array field. */
  readonly type: FieldType;
  /** The field must be present and non-null. */
  readonly required?: boolean;
  /** The field is an array of `type`. */
  readonly array?: boolean;
  /** Nested contract, for object fields the API models rather than passes through. */
  readonly shape?: Shape;
  /** The nested contract is this shape itself - trace nodes nest arbitrarily deep. */
  readonly recursive?: boolean;
}

type Shape = Readonly<Record<string, FieldSpec>>;

/** One span. Nests through `ch` to whatever depth the operation produced. */
const TRACE_NODE: Shape = {
  n: { type: "string" },
  o: { type: "string" },
  t: { type: "object" },
  d: { type: "number" },
  e: { type: "object" },
  c: { type: "string" },
  m: { type: "string" },
  s: { type: "string" },
  so: { type: "number" },
  ch: { type: "object", array: true, recursive: true },
};

const REQUEST_ATTRIBUTES: Shape = {
  m: { type: "string" },
  sc: { type: "number" },
  ou: { type: "string" },
};

/** No `st`: see the note at the top of this file. */
const REQUEST_SNAPSHOT: Shape = {
  ct: { type: "string" },
  ti: { type: "string", required: true },
  d: { type: "number" },
  p: { type: "string" },
  op: { type: "string" },
  u: { type: "string" },
  tg: { type: "object" },
  e: { type: "object" },
  a: { type: "object", shape: REQUEST_ATTRIBUTES },
  t: { type: "object", array: true, shape: TRACE_NODE },
};

/** No `st` here either, for the same reason. */
const JOB_SNAPSHOT: Shape = {
  i: { type: "string", required: true },
  ti: { type: "string" },
  n: { type: "string" },
  q: { type: "string" },
  s: { type: "string" },
  c: { type: "string" },
  d: { type: "number" },
  ea: { type: "string" },
  wd: { type: "number" },
  am: { type: "number" },
  ma: { type: "number" },
  tg: { type: "object" },
  e: { type: "object" },
  t: { type: "object", array: true, shape: TRACE_NODE },
};

const RUNTIME_METRICS: Shape = {
  c: {
    type: "object",
    shape: {
      u: { type: "number" },
      s: { type: "number" },
      p: { type: "number" },
    },
  },
  m: {
    type: "object",
    shape: {
      r: { type: "number" },
      ht: { type: "number" },
      hu: { type: "number" },
      e: { type: "number" },
      ab: { type: "number" },
      p: { type: "number" },
    },
  },
  g: {
    type: "object",
    shape: {
      c: { type: "number" },
      td: { type: "number" },
      b: {
        type: "object",
        shape: {
          m: { type: "number" },
          j: { type: "number" },
          i: { type: "number" },
        },
      },
    },
  },
  e: {
    type: "object",
    shape: {
      l: { type: "number" },
      u: { type: "number" },
    },
  },
};

const CUSTOM_METRIC: Shape = {
  n: { type: "string", required: true },
  t: { type: "string" },
  v: { type: "number" },
  tg: { type: "object" },
  d: { type: "string" },
  l: { type: "object" },
  lu: { type: "number" },
  k: { type: "string" },
  iv: { type: "number" },
  q50: { type: "number" },
  q95: { type: "number" },
  q99: { type: "number" },
  ct: { type: "number" },
  sm: { type: "number" },
  mx: { type: "number" },
};

const LOG_ENTRY: Shape = {
  timestamp: { type: "number", required: true },
  text: { type: "string", required: true },
  traceId: { type: "string" },
  spanId: { type: "string" },
  level: { type: "string" },
  context: { type: "string" },
  attributes: { type: "object" },
};

/** The batch body the agent POSTs to the collector. */
export const TELEMETRY_BATCH: Shape = {
  serviceId: { type: "string", required: true },
  serviceVersion: { type: "string" },
  forwardLogs: { type: "boolean" },
  snapshots: { type: "object", array: true, shape: REQUEST_SNAPSHOT },
  jobs: { type: "object", array: true, shape: JOB_SNAPSHOT },
  runtime: { type: "object", shape: RUNTIME_METRICS },
  custom: { type: "object", array: true, shape: CUSTOM_METRIC },
  logs: { type: "object", array: true, shape: LOG_ENTRY },
};

export interface ValidateOptions {
  /**
   * Reject keys the contract does not declare, mirroring the API's
   * `forbidNonWhitelisted` validation. Off by default, matching a plain
   * `validate()` call, which ignores undeclared properties.
   */
  readonly forbidUnknown?: boolean;
}

/**
 * Checks a batch body against the contract and returns one message per problem,
 * empty when the payload is acceptable. Paths are dotted, with array indices, so
 * a failure names the exact field: `snapshots[0].a.sc`.
 */
export function validateTelemetryPayload(
  payload: unknown,
  options: ValidateOptions = {},
): string[] {
  const errors: string[] = [];
  checkShape(payload, TELEMETRY_BATCH, "", options, errors);
  return errors;
}

function checkShape(
  value: unknown,
  shape: Shape,
  path: string,
  options: ValidateOptions,
  errors: string[],
): void {
  if (!isPlainObject(value)) {
    errors.push(`${path || "payload"}: expected an object`);
    return;
  }

  for (const [key, spec] of Object.entries(shape)) {
    const present = value[key] !== undefined && value[key] !== null;
    if (!present) {
      if (spec.required) {
        errors.push(`${join(path, key)}: required`);
      }
      continue;
    }
    checkField(value[key], spec, shape, join(path, key), options, errors);
  }

  if (options.forbidUnknown) {
    for (const key of Object.keys(value)) {
      if (!(key in shape)) {
        errors.push(`${join(path, key)}: not declared by the contract`);
      }
    }
  }
}

function checkField(
  value: unknown,
  spec: FieldSpec,
  parent: Shape,
  path: string,
  options: ValidateOptions,
  errors: string[],
): void {
  if (spec.array) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return;
    }
    value.forEach((item, index) => {
      checkField(
        item,
        { ...spec, array: false },
        parent,
        `${path}[${index}]`,
        options,
        errors,
      );
    });
    return;
  }

  // `recursive` means "the shape this field lives in", which is how a span's
  // children are described without the contract referring to itself before it
  // is defined.
  const nested = spec.recursive ? parent : spec.shape;
  if (nested) {
    checkShape(value, nested, path, options, errors);
    return;
  }

  if (spec.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${path}: expected an object`);
    }
    return;
  }
  if (typeof value !== spec.type) {
    errors.push(`${path}: expected a ${spec.type}, got ${typeof value}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
