// The combinators behind ConnectaConfig's one schema (src/config.ts).
//
// A schema here is a value that does three jobs at once, so they cannot drift
// apart: its type parameters produce the TypeScript type a deployment writes
// (`ConfigInput`) and the resolved shape core reads (`ConfigOutput`); its
// object shapes drive unknown-key rejection; and each field's `parse` and
// `absent` carry its validation and its default. There is one validation
// policy: a value that is present and wrong throws, with its path, before
// createConnecta does any work (INV-11). Nothing warns and falls back.
//
// Deliberately small. Opaque fields (connectors, modules, functions) are
// checked by identity or shape and passed through untouched, never cloned, so
// a private-field receiver or a frozen object reaches core as configured.

/** One configuration field: its input type, resolved type, and optionality. */
export interface Field<In, Out, Opt extends boolean = boolean> {
  /** Whether a deployment may omit the field. */
  readonly optional: Opt;
  /** Resolve a present (own, not `undefined`) value or throw. */
  readonly parse: (value: unknown, path: string) => Out;
  /** Resolve an omitted value: its default, `undefined`, or a throw. */
  readonly absent: (path: string) => Out;
  /** Child fields of a closed object, walked for unknown keys. */
  readonly shape?: Shape;
  /** Element field of an array or record, walked for unknown keys. */
  readonly element?: Field<unknown, unknown>;
  /** Whether `element` describes record values rather than array items. */
  readonly keyed?: boolean;
  /** Closed object shapes chosen by the string at one key, walked for unknown keys. */
  readonly variants?: Variants;
  /** Whether a closed object carries behaviour, so the walk returns it as given. */
  readonly instance?: boolean;
  /** Whether a record's values must be strings: header values, extra parameters. */
  readonly strings?: boolean;
  /** Phantom input type; never set. */
  readonly __in?: In;
}

// `any` is the variance escape hatch every schema library needs: a Field's
// `parse` takes its input, so only `any` lets every concrete field fit a shape.
type AnyField = Field<any, any, boolean>;

export type Shape = { readonly [key: string]: AnyField };

/** A discriminated union of closed objects: `cases[value[key]]`, else `cases[otherwise]`. */
interface Variants {
  readonly key: string;
  readonly cases: Readonly<Record<string, Shape>>;
  readonly otherwise?: string;
}

type InputOf<F> = F extends Field<infer In, unknown, boolean> ? In : never;
type OutputOf<F> = F extends Field<unknown, infer Out, boolean> ? Out : never;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * What a deployment writes for an object schema. Optional fields also accept
 * an explicit `undefined`, so an optional module can be wired as
 * `vault: key ? encryptedCredentialVault(storage, key) : undefined`.
 */
export type ConfigInput<S extends Shape> = Simplify<
  {
    -readonly [K in keyof S as S[K]["optional"] extends true ? K : never]?: InputOf<S[K]> | undefined;
  } & {
    -readonly [K in keyof S as S[K]["optional"] extends true ? never : K]: InputOf<S[K]>;
  }
>;

/** What core reads for an object schema: every default already applied. */
export type ConfigOutput<S extends Shape> = Simplify<{
  readonly [K in keyof S]: OutputOf<S[K]>;
}>;

/** A structural configuration mistake, thrown before construction does work. */
export class ConfigError extends TypeError {
  override readonly name = "ConfigError";
}

function fail(message: string): never {
  throw new ConfigError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(value: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

interface WholeOptions {
  /** Smallest accepted value. */
  min: 0 | 1;
  /** Largest accepted value, when there is one. */
  max?: number;
  /** Unit named in the `max` refusal, e.g. "milliseconds". */
  unit?: string;
}

/** A safe integer at or above `min`; the default applies only when omitted. */
export function whole(options: WholeOptions & { default: number }): Field<number, number, true>;
export function whole(options: WholeOptions): Field<number, number | undefined, true>;
export function whole(options: WholeOptions & { default?: number }): Field<number, number | undefined, true> {
  const kind = options.min === 1 ? "positive" : "non-negative";
  return {
    optional: true,
    parse: (value, path) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < options.min) {
        fail(`${path} must be a ${kind} whole number.`);
      }
      if (options.max !== undefined && value > options.max) {
        fail(
          `${path} must be at most ${options.max.toLocaleString("en-US")}` + (options.unit ? ` ${options.unit}.` : "."),
        );
      }
      return value;
    },
    absent: () => options.default,
  };
}

/** A non-negative finite number, fractions allowed. */
export function seconds(options: { default: number }): Field<number, number, true> {
  return {
    optional: true,
    parse: (value, path) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        fail(`${path} must be a non-negative number of seconds.`);
      }
      return value;
    },
    absent: () => options.default,
  };
}

export function text(): Field<string, string | undefined, true> {
  return {
    optional: true,
    parse: (value, path) => {
      if (typeof value !== "string") fail(`${path} must be a string.`);
      return value;
    },
    absent: () => undefined,
  };
}

/**
 * A value core checks by shape and passes through untouched: a connector, a
 * module, an executor. `check` throws its own message for a wrong value;
 * `resolve` maps the accepted value (or `undefined`, when omitted) to what
 * core reads.
 */
export function opaque<In, Out = In | undefined>(
  options: {
    check?: (value: unknown, path: string) => void;
    resolve?: (value: In | undefined) => Out;
  } = {},
): Field<In, Out, true> {
  const resolve = options.resolve ?? ((value: In | undefined) => value as Out);
  return {
    optional: true,
    parse: (value, path) => {
      options.check?.(value, path);
      return resolve(value as In);
    },
    absent: () => resolve(undefined),
  };
}

/** A function, never called, read, or serialized by configuration. */
export function fn<F extends (...args: never[]) => unknown>(): Field<F, F | undefined, true> {
  return opaque<F>({
    check: (value, path) => {
      if (typeof value !== "function") fail(`${path} must be a function.`);
    },
  });
}

/** The same field, but a deployment must supply it. */
export function required<In, Out>(
  field: Field<In, Out, boolean>,
  message?: (path: string) => string,
): Field<In, Exclude<Out, undefined>, false> {
  return {
    ...field,
    optional: false,
    parse: field.parse as (value: unknown, path: string) => Exclude<Out, undefined>,
    absent: (path) => fail(message ? message(path) : `${path} is required.`),
  };
}

/**
 * A closed object. Its keys are the shape's keys; anything else is refused
 * by the unknown-key walk before any value is read. An omitted object
 * resolves to its children's defaults.
 */
export function object<S extends Shape>(
  shape: S,
): Field<ConfigInput<S>, ConfigOutput<S>, true> & { readonly shape: S } {
  const resolve = (value: object | undefined, path: string): ConfigOutput<S> => {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const child = value === undefined ? undefined : ownValue(value, key);
      const resolved = child === undefined ? field.absent(`${path}.${key}`) : field.parse(child, `${path}.${key}`);
      // An unset field without a default stays absent, as it was configured.
      if (resolved !== undefined) out[key] = resolved;
    }
    return Object.freeze(out) as ConfigOutput<S>;
  };
  return {
    optional: true,
    shape,
    parse: (value, path) => {
      if (!isPlainObject(value)) fail(`${path} must be an object.`);
      return resolve(value, path);
    },
    absent: (path) => resolve(undefined, path),
  };
}

/** A list whose items each satisfy `item`. */
export function array<In, Out>(
  item: Field<In, Out, boolean>,
): Field<In[], readonly Exclude<Out, undefined>[] | undefined, true> {
  return {
    optional: true,
    element: item as Field<unknown, unknown>,
    parse: (value, path) => {
      if (!Array.isArray(value)) fail(`${path} must be an array.`);
      return Object.freeze(
        value.map((entry, index) => item.parse(entry, `${path}[${index}]`) as Exclude<Out, undefined>),
      );
    },
    absent: () => undefined,
  };
}

/** An object keyed by caller-chosen names, each value satisfying `value`. */
export function record<In, Out>(
  value: Field<In, Out, boolean>,
): Field<Record<string, In>, Readonly<Record<string, Exclude<Out, undefined>>> | undefined, true> {
  return {
    optional: true,
    element: value as Field<unknown, unknown>,
    keyed: true,
    parse: (input, path) => {
      if (!isPlainObject(input)) fail(`${path} must be an object.`);
      // Keys are caller-chosen, so `__proto__`, `constructor`, and the like
      // must stay ordinary entries: no prototype to assign through or inherit.
      const out = Object.create(null) as Record<string, Exclude<Out, undefined>>;
      for (const key of Object.keys(input)) {
        // An explicitly undefined entry is an omitted one, as for any field.
        if (input[key] === undefined) continue;
        out[key] = value.parse(input[key], `${path}.${key}`) as Exclude<Out, undefined>;
      }
      return Object.freeze(out);
    },
    absent: () => undefined,
  };
}

/**
 * A map of caller-chosen names to strings, such as static headers or extra
 * OAuth parameters. The walk copies it through property descriptors, so an
 * accessor is refused by path unrun and a non-string value by path unechoed.
 */
export function strings(): Field<Record<string, string>, Readonly<Record<string, string>> | undefined, true> {
  return { ...record(text()), strings: true };
}

/**
 * A closed object that carries behaviour, such as an `api()` tool. The walk
 * checks it like any closed object (own keys declared, no own accessor, and
 * no inherited accessor at a declared key) but returns the original rather
 * than a copy, so a prototype method keeps its receiver and a handler that
 * reads `#private` fields still finds them. It may be a class instance.
 */
export function instance<F extends AnyField>(field: F): F & { readonly instance: true } {
  return { ...field, instance: true };
}

/**
 * A closed object whose allowed keys depend on a discriminant, such as
 * `remoteMcp({ auth: { type: "headers", headers } })`. An omitted
 * discriminant selects `otherwise` when given; an omitted one without it, an
 * unrecognized one, or a value that is not an object throws with its path and
 * the valid values, so no union falls through to "no case". Only the walk
 * reads variants; the factory validates the remaining values itself.
 */
export function variants(
  key: string,
  cases: Readonly<Record<string, Shape>>,
  otherwise?: string,
): Field<unknown, unknown, true> {
  return {
    ...opaque(),
    variants: { key, cases, ...(otherwise !== undefined ? { otherwise } : {}) },
  };
}

/**
 * A closed object for the unknown-key walk only: each named key may hold
 * anything, which its factory validates. For the options of a built-in
 * factory, where `object()` would resolve values the factory already owns.
 */
export function keys<const K extends string>(...names: K[]): { readonly [P in K]: Field<unknown, unknown, true> } {
  const field = opaque();
  return Object.fromEntries(names.map((name) => [name, field])) as { readonly [P in K]: Field<unknown, unknown, true> };
}

/** Every key of every member of a union, so a shape can be checked against it. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * The closed options of a built-in factory, checked against its options type:
 * a key the type declares but the shape omits, or the reverse, fails to
 * compile, so the runtime walk cannot drift from the published type.
 */
export function optionsOf<T>() {
  return <S extends { readonly [K in Exclude<KeysOfUnion<T>, symbol>]-?: AnyField }>(
    shape: S & Record<Exclude<keyof S, KeysOfUnion<T>>, never>,
  ): Field<unknown, unknown, true> & { readonly shape: S } => ({ ...opaque(), shape });
}

/**
 * Refuse a factory's unknown options and accessors before it reads any value,
 * naming each path: `api("crm").maxResultByte`. Returns the options as a
 * plain copy read through property descriptors, which the factory reads in
 * place of what it was given, so no getter or Proxy trap of the caller's runs
 * later either. Custom implementations a factory accepts (stores, handlers,
 * executors) are `opaque()` in its shape and pass through untouched; an
 * object that carries behaviour (an `api()` tool) is `instance()`, checked in
 * place and passed through as given.
 */
export function assertKnownOptions<T>(value: T, path: string, field: AnyField): T {
  const read = readPlain(value, path, field);
  if (read.unknown.length === 0) return read.value as T;
  return fail(
    `Unknown option${read.unknown.length === 1 ? "" : "s"}: ${read.unknown.join(", ")}. ` +
      "Check the spelling against the factory's options type.",
  );
}

/** What one inspection of an object found: its kind, prototype, and own properties. */
interface Inspected {
  readonly array: boolean;
  /**
   * Whether it is a plain record: a null prototype, or one whose own
   * prototype is null (`Object.prototype` of this or another realm).
   */
  readonly plain: boolean;
  readonly proto: object | null;
  readonly own: ReadonlyArray<readonly [string | symbol, PropertyDescriptor]>;
}

/**
 * Own property descriptors, read without invoking any accessor. A config
 * object that cannot be inspected (a Proxy whose trap throws, or a revoked
 * one) is refused by path; the trap's own message never surfaces.
 */
function inspect(value: object, path: string): Inspected {
  try {
    const proto = Reflect.getPrototypeOf(value);
    return {
      array: Array.isArray(value),
      plain: proto === null || Reflect.getPrototypeOf(proto) === null,
      proto,
      own: Reflect.ownKeys(value).flatMap((key) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        return descriptor ? [[key, descriptor] as const] : [];
      }),
    };
  } catch {
    return fail(`${path} could not be read as plain configuration.`);
  }
}

/** Whether `Array.isArray` holds, refusing by path a value that cannot say. */
function isArrayAt(value: object, path: string): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return fail(`${path} could not be read as plain configuration.`);
  }
}

/** What the walk refused: undeclared keys, then values it declined to read or accept. */
interface WalkState {
  readonly unknown: string[];
  readonly refused: string[];
}

const isAccessor = (descriptor: PropertyDescriptor): boolean => "get" in descriptor || "set" in descriptor;

/** A data property's value, or `undefined` for an accessor, recorded by path and never run. */
function dataValue(descriptor: PropertyDescriptor, path: string, state: WalkState): unknown {
  if (!isAccessor(descriptor)) return descriptor.value;
  state.refused.push(`${path} must be a plain value, not a getter or setter.`);
  return undefined;
}

/**
 * The descriptor a declared key inherits, read along the prototype chain
 * without invoking an accessor. A chain that cannot be inspected is refused
 * by path like the object itself.
 */
function inherited(proto: object | null, key: string, path: string): PropertyDescriptor | undefined {
  const seen = new Set<object>();
  try {
    for (let at = proto; at !== null && !seen.has(at); at = Reflect.getPrototypeOf(at)) {
      seen.add(at);
      const descriptor = Reflect.getOwnPropertyDescriptor(at, key);
      if (descriptor) return descriptor;
    }
    return undefined;
  } catch {
    return fail(`${path} could not be read as plain configuration.`);
  }
}

/**
 * Inspect a value a closed object or record slot holds. An array, or a
 * class instance where only plain data belongs, is refused by path before
 * any of its keys is read: `remoteMcp([...])` must not pass for options.
 */
function inspectRecord(value: object, path: string, field: AnyField): Inspected {
  const inspected = inspect(value, path);
  if (inspected.array) fail(`${path} must be an object.`);
  if (!inspected.plain && !field.instance) fail(`${path} must be a plain object.`);
  return inspected;
}

/**
 * The case a discriminant selects. A missing one selects `otherwise` when the
 * union has a default; any other missing, unrecognized, or computed
 * discriminant throws with the valid values, so a misspelled
 * `type: "header"` cannot construct as if no case applied. The value itself
 * is never echoed.
 */
function selectShape(inspected: Inspected, path: string, variants: Variants): Shape {
  const at = `${path}.${variants.key}`;
  const valid = Object.keys(variants.cases)
    .map((name) => JSON.stringify(name))
    .join(", ");
  const descriptor = inspected.own.find(([key]) => key === variants.key)?.[1];
  if (descriptor && isAccessor(descriptor)) fail(`${at} must be a plain value, not a getter or setter.`);
  const discriminant: unknown = descriptor?.value;
  if (discriminant === undefined) {
    if (variants.otherwise !== undefined) return variants.cases[variants.otherwise]!;
    return fail(`${at} is required: one of ${valid}.`);
  }
  if (typeof discriminant !== "string" || !Object.hasOwn(variants.cases, discriminant)) {
    return fail(`${at} must be one of ${valid}.`);
  }
  return variants.cases[discriminant]!;
}

/**
 * Read a configuration value the way the schema sees it: every own key it
 * does not declare, as paths, and the value as a plain copy built only from
 * the property descriptors this walk inspected. Callers resolve that copy,
 * never the original, so no property is read through `[[Get]]` twice or at
 * all: no getter runs, a Proxy's `get` trap never fires, and no value is
 * echoed.
 *
 * Unknown keys anywhere are reported first. With none, a declared key holding
 * an accessor is refused by path, since a plain configuration object has no
 * reason to compute a value, and a getter that throws or changes between
 * reads would break the one-read guarantee. Only own string keys count, so a
 * prototype contributes nothing. A closed object or record slot takes a
 * plain object only; an array or class instance there is refused by path.
 * Arrays are walked by the same rules, the items of an `opaque()` array
 * included (`allowedOrigins`, `auth`); an `instance()` object (an `api()`
 * tool) is checked the same way but returned as given; any other `opaque()`
 * value (a connector, module, executor, storage, or logger) is never entered
 * and passes through as configured. Configuration is operator-authored and
 * trusted: the walk refuses mistakes by path without echoing a value; it is
 * not a sandbox for hostile objects.
 */
export function readPlain(value: unknown, path: string, field: AnyField): { unknown: string[]; value: unknown } {
  const state: WalkState = { unknown: [], refused: [] };
  const plain = walk(value, path, field, state);
  if (state.unknown.length === 0 && state.refused.length > 0) fail(state.refused[0]!);
  return { unknown: state.unknown, value: plain };
}

function walk(value: unknown, path: string, field: AnyField, state: WalkState): unknown {
  if (
    field.variants &&
    value !== undefined &&
    (typeof value !== "object" || value === null || isArrayAt(value, path))
  ) {
    return fail(`${path} must be an object.`);
  }
  if (typeof value !== "object" || value === null) return value;
  if (field.shape || field.variants) {
    const inspected = inspectRecord(value, path, field);
    const shape = field.shape ?? selectShape(inspected, path, field.variants!);
    const unknown = inspected.own
      .filter(([key]) => typeof key !== "string" || !Object.hasOwn(shape, key))
      .map(([key]) => `${path}.${String(key)}`)
      .sort();
    if (unknown.length > 0) {
      state.unknown.push(...unknown);
      return undefined;
    }
    const out: Record<string, unknown> = {};
    for (const [key, descriptor] of inspected.own) {
      const child = `${path}.${String(key)}`;
      out[key as string] = walk(dataValue(descriptor, child, state), child, shape[key as string]!, state);
    }
    if (!field.instance) return out;
    // A declared key the object inherits, such as a class's `handler()`, is
    // read from its prototype when called; it must not be a computed one.
    for (const key of Object.keys(shape)) {
      if (Object.hasOwn(out, key)) continue;
      const descriptor = inherited(inspected.proto, key, `${path}.${key}`);
      if (descriptor) dataValue(descriptor, `${path}.${key}`, state);
    }
    return value;
  }
  if (field.keyed) {
    const inspected = inspectRecord(value, path, field);
    // Keys are caller-chosen, so the copy has no prototype for `__proto__` to reach.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of inspected.own) {
      if (typeof key !== "string" || !descriptor.enumerable) continue;
      const child = `${path}.${key}`;
      const entry = dataValue(descriptor, child, state);
      if (field.strings && !isAccessor(descriptor) && typeof entry !== "string") {
        state.refused.push(`${child} must be a string.`);
      }
      out[key] = walk(entry, child, field.element!, state);
    }
    return out;
  }
  if (!field.element && !isArrayAt(value, path)) return value;
  const inspected = inspect(value, path);
  if (!inspected.array) return value;
  const element = field.element ?? OPAQUE;
  const out: unknown[] = [];
  for (const [key, descriptor] of inspected.own) {
    if (key === "length") {
      const length: unknown = descriptor.value;
      if (Number.isInteger(length) && (length as number) >= 0 && (length as number) <= 0xffff_ffff) {
        out.length = length as number;
      }
      continue;
    }
    // Only indices are items; any other key on an array is never read.
    if (typeof key !== "string" || String(Number(key) >>> 0) !== key) continue;
    const child = `${path}[${key}]`;
    out[Number(key)] = walk(dataValue(descriptor, child, state), child, element, state);
  }
  return out;
}

const OPAQUE: AnyField = opaque();
