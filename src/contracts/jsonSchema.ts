import { z } from 'zod';

/**
 * ONE SCHEMA, TWO CONSUMERS.
 *
 * A headless `claude -p --json-schema` session enforces its structured output
 * against a JSON Schema, while this codebase validates the same bytes with a
 * zod schema and infers its types from it. Writing both by hand is the
 * one-concept-two-definitions drift the root contract forbids, and it is
 * exactly what the out-of-product supervisor scripts did: a JSON constant and
 * a hand-written validator that had to be kept in step by reading.
 *
 * So the JSON Schema is DERIVED from the zod schema, here, for the subset of
 * zod this repository's structured-output contracts use: strict objects,
 * strings with length bounds, enums, arrays, optionals, and a refinement
 * wrapper (whose predicate has no JSON Schema form and is validated by zod on
 * the way back in). Anything else THROWS at module load, so a contract that
 * reaches for a node this function cannot express fails the test suite
 * rather than shipping a schema the model was never held to.
 *
 * Deliberately not `zod-to-json-schema`: it is a transitive dependency here,
 * not a declared one, and its output covers far more of zod than a prompt
 * contract should ever use. A converter that refuses is the guard.
 */
export type JsonSchema = Record<string, unknown>;

/** One zod 4 check, as its definition names it (`min_length`, `number_format`, `custom`, …). */
interface CheckDef {
  readonly check: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly value?: number;
  readonly inclusive?: boolean;
  readonly format?: string;
}

function checksOf(schema: z.ZodType): CheckDef[] {
  return (schema._zod.def.checks ?? []).map((check) => check._zod.def as CheckDef);
}

export function jsonSchemaFromZod(schema: z.ZodType): JsonSchema {
  const def = schema._zod.def;
  // A refinement is a `custom` check on the node itself (zod 4 has no
  // wrapper for it): it has no JSON Schema form, the node's shape is what the
  // model is held to, and zod enforces the predicate on the way back.
  const checks = checksOf(schema).filter((check) => check.check !== 'custom');
  switch (def.type) {
    case 'object': {
      const object = schema as z.ZodObject;
      if (checks.length > 0) throw new Error(`jsonSchemaFromZod: unsupported object check "${checks[0]!.check}"`);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(object.shape as Record<string, z.ZodType>)) {
        if (child._zod.def.type === 'optional') {
          properties[key] = jsonSchemaFromZod((child as z.ZodOptional).unwrap() as z.ZodType);
        } else {
          properties[key] = jsonSchemaFromZod(child);
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out['required'] = required;
      // `.strict()` is a catch-all of `never`: no other key is admitted.
      if (object._zod.def.catchall?._zod.def.type === 'never') out['additionalProperties'] = false;
      return out;
    }
    case 'string': {
      const out: JsonSchema = { type: 'string' };
      for (const check of checks) {
        if (check.check === 'min_length') out['minLength'] = check.minimum;
        else if (check.check === 'max_length') out['maxLength'] = check.maximum;
        else throw new Error(`jsonSchemaFromZod: unsupported string check "${check.check}"`);
      }
      return out;
    }
    case 'number': {
      const out: JsonSchema = { type: 'number' };
      for (const check of checks) {
        if (check.check === 'number_format' && check.format === 'safeint') out['type'] = 'integer';
        else if (check.check === 'greater_than' && check.inclusive) out['minimum'] = check.value;
        else if (check.check === 'less_than' && check.inclusive) out['maximum'] = check.value;
        else throw new Error(`jsonSchemaFromZod: unsupported number check "${check.check}"`);
      }
      return out;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { enum: [...(schema as z.ZodEnum).options] };
    case 'literal': {
      const values = (schema as z.ZodLiteral).values;
      if (values.size !== 1) throw new Error('jsonSchemaFromZod: a literal must name exactly one value');
      return { enum: [...values] };
    }
    case 'array':
      // Length bounds are not expressed, as they never were: zod enforces
      // them on the way back in, like a refinement.
      return { type: 'array', items: jsonSchemaFromZod((schema as z.ZodArray).element as z.ZodType) };
    case 'optional':
      throw new Error('jsonSchemaFromZod: optional is only supported as an object property');
    default:
      throw new Error(`jsonSchemaFromZod: unsupported zod node "${def.type}"`);
  }
}
