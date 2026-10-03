import type { Json } from '@featherlog/contracts';

type Common = { key: string; title: string; description?: string };

/** One editable setting, read from a plugin's settings schema. */
export type Field = Common &
  (
    | { kind: 'number'; integer: boolean; min?: number; max?: number }
    | { kind: 'choice'; options: { value: string; label: string }[] }
    | { kind: 'boolean' }
    | { kind: 'text' }
    /** A write-only string (an API key): stored encrypted, never read back (design §6.6). */
    | { kind: 'secret' }
  );

type JsonObject = { [key: string]: Json };

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The form fields for a `contributes.settings.schema`. Only the property types
 * the shell validates are editable (design §6.6); anything else is left out
 * rather than rendered as a control that could never save.
 */
export function readFields(schema: Json): Field[] {
  if (!isObject(schema) || !isObject(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([key, property]): Field[] => {
    if (!isObject(property)) return [];
    const common: Common = {
      key,
      title: typeof property.title === 'string' ? property.title : key,
      ...(typeof property.description === 'string' ? { description: property.description } : {}),
    };
    switch (property.type) {
      case 'integer':
      case 'number':
        return [
          {
            ...common,
            kind: 'number',
            integer: property.type === 'integer',
            ...(typeof property.minimum === 'number' ? { min: property.minimum } : {}),
            ...(typeof property.maximum === 'number' ? { max: property.maximum } : {}),
          },
        ];
      case 'boolean':
        return [{ ...common, kind: 'boolean' }];
      case 'string': {
        if (property.writeOnly === true) return [{ ...common, kind: 'secret' }];
        if (!Array.isArray(property.enum)) return [{ ...common, kind: 'text' }];
        const values = property.enum.filter((value): value is string => typeof value === 'string');
        return [{ ...common, kind: 'choice', options: values.map((value) => ({ value, label: labelFor(property, value) })) }];
      }
      default:
        return [];
    }
  });
}

/** Enum labels come from the standard `oneOf: [{ const, title }]` form, if the schema has it. */
function labelFor(property: JsonObject, value: string): string {
  const entries = Array.isArray(property.oneOf) ? property.oneOf : [];
  const entry = entries.find((option) => isObject(option) && option.const === value);
  return isObject(entry) && typeof entry.title === 'string' ? entry.title : value;
}
