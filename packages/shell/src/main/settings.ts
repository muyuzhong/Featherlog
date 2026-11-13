import { join } from 'node:path';
import { renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Clock, Json, Logger, PluginManifest, PluginSettings } from '@featherlog/contracts';
import { JsonFiles, readJsonSync } from './storage';
import { invalid, isJson, record } from './validation';

const shellSchema = {
  paper: { type: 'string', enum: ['vellum', 'golden', 'aged'], default: 'vellum' },
  compatMode: { type: 'boolean', default: false },
  autoUpdate: { type: 'boolean', default: true },
  sound: { type: 'boolean', default: true },
  volume: { type: 'integer', minimum: 0, maximum: 10, default: 6 },
};

type Listener = (scope: string, key: string, value: Json) => void;

export function loadSettings(userData: string, manifests: PluginManifest[], files: JsonFiles,
  log: Logger, clock: Clock): Settings {
  // Invalid manifest defaults are programming errors, not damaged user settings.
  const defaults = new Settings(userData, manifests, undefined, files, log);
  const path = join(userData, 'settings.json');
  try {
    return new Settings(userData, manifests, readJsonSync(path), files, log);
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause &&
      ['shell/storage-corrupt', 'shell/invalid-setting'].includes(String(cause.code)))) throw cause;
    const backup = `${path}.corrupt-${clock.now()}-${randomUUID()}`;
    // If backup fails, stop before defaults can overwrite the recoverable original.
    renameSync(path, backup);
    log.warn('Damaged settings backed up; using defaults', { backup, cause });
    return defaults;
  }
}

export class Settings {
  private schemas = new Map<string, Record<string, unknown>>([['shell', shellSchema]]);
  private values: Record<string, Record<string, Json>> = Object.create(null);
  private preservedPlugins: Record<string, Record<string, Json>> = Object.create(null);
  private listeners = new Set<Listener>();
  private queue = Promise.resolve();

  constructor(
    private userData: string,
    manifests: PluginManifest[],
    saved: Json | undefined,
    private files: JsonFiles,
    private log: Logger,
  ) {
    for (const manifest of manifests) {
      this.schemas.set(manifest.id, this.schemaProperties(manifest));
    }
    for (const [scope, schema] of this.schemas) {
      this.values[scope] = this.buildDefaults(scope, schema);
    }
    if (saved !== undefined) {
      if (!record(saved) || !record(saved.shell) || !record(saved.plugins)) {
        invalid('Invalid settings file', 'shell/storage-corrupt');
      }
      for (const [pluginId, pluginValues] of Object.entries(saved.plugins)) {
        if (this.schemas.has(pluginId)) continue;
        if (!record(pluginValues)) invalid('Invalid settings scope', 'shell/storage-corrupt');
        const preserved: Record<string, Json> = Object.create(null);
        for (const [key, value] of Object.entries(pluginValues)) {
          if (!isJson(value)) invalid(`Invalid setting ${pluginId}/${key}`, 'shell/invalid-setting');
          preserved[key] = structuredClone(value) as Json;
        }
        this.preservedPlugins[pluginId] = preserved;
      }
      for (const scope of this.schemas.keys()) {
        const values = scope === 'shell' ? saved.shell : saved.plugins[scope];
        if (values === undefined) continue;
        if (!record(values)) invalid('Invalid settings scope', 'shell/storage-corrupt');
        for (const [key, value] of Object.entries(values)) {
          // Preserve forward compatibility with settings removed from newer manifests.
          if (!Object.hasOwn(this.schemas.get(scope)!, key)) continue;
          const property = this.schemas.get(scope)![key];
          if (record(property) && property.writeOnly === true) continue;
          this.validate(scope, key, value);
          this.values[scope]![key] = structuredClone(value) as Json;
        }
      }
    }
  }

  private schemaProperties(manifest: PluginManifest): Record<string, unknown> {
    const schema = manifest.contributes?.settings?.schema;
    return record(schema) && record(schema.properties) ? schema.properties : {};
  }

  private buildDefaults(scope: string, schema: Record<string, unknown>): Record<string, Json> {
    const values: Record<string, Json> = Object.create(null);
    for (const [key, property] of Object.entries(schema)) {
      if (record(property) && property.writeOnly !== true && property.default !== undefined) {
        this.validate(scope, key, property.default, schema);
        values[key] = structuredClone(property.default) as Json;
      }
    }
    return values;
  }

  private emitChange(scope: string, key: string, value: Json): void {
    for (const listener of this.listeners) {
      try {
        listener(scope, key, structuredClone(value));
      } catch (cause) {
        this.log.error('Settings listener failed', cause);
      }
    }
  }

  private validate(scope: string, key: string, value: unknown,
    schemaOverride?: Record<string, unknown>): void {
    const schema = schemaOverride ?? this.schemas.get(scope);
    const property = schema && Object.hasOwn(schema, key) ? schema[key] : undefined;
    let valid = record(property) && property.writeOnly !== true && isJson(value);
    if (valid && record(property)) {
      switch (property.type) {
        case 'integer':
        case 'number':
          valid = typeof value === 'number' && Number.isFinite(value) &&
            (property.type !== 'integer' || Number.isInteger(value)) &&
            (typeof property.minimum !== 'number' || value >= property.minimum) &&
            (typeof property.maximum !== 'number' || value <= property.maximum);
          break;
        case 'string':
          valid = typeof value === 'string' &&
            (!Array.isArray(property.enum) || property.enum.includes(value));
          break;
        case 'boolean':
          valid = typeof value === 'boolean';
          break;
        default:
          valid = false;
      }
    }
    if (!valid) invalid(`Invalid setting ${scope}/${key}`, 'shell/invalid-setting');
  }

  isSecret(scope: string, key: string): boolean {
    const schema = this.schemas.get(scope);
    const property = schema && Object.hasOwn(schema, key) ? schema[key] : undefined;
    return record(property) && property.type === 'string' && property.writeOnly === true;
  }

  all(): Record<string, Record<string, Json>> {
    return structuredClone(this.values);
  }

  forPlugin(scope: string): PluginSettings {
    return {
      get: <T extends Json>(key: string) => structuredClone(this.values[scope]?.[key]) as T | undefined,
      onChange: callback => this.onChange((changed, key, value) => {
        if (scope === changed) callback(key, value);
      }),
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  registerPlugin(manifest: PluginManifest): void {
    if (manifest.id === 'shell') invalid('Reserved settings scope: shell');
    const schema = this.schemaProperties(manifest);
    const next = this.buildDefaults(manifest.id, schema);
    const previous = this.values[manifest.id];
    const source = previous ?? this.preservedPlugins[manifest.id];
    if (source) {
      for (const [key, value] of Object.entries(source)) {
        if (!Object.hasOwn(schema, key)) continue;
        const property = schema[key];
        if (record(property) && property.writeOnly === true) continue;
        try {
          this.validate(manifest.id, key, value, schema);
          next[key] = structuredClone(value) as Json;
        } catch (cause) {
          this.log.warn('Ignoring invalid preserved plugin setting', { scope: manifest.id, key, cause });
        }
      }
    }
    this.schemas.set(manifest.id, schema);
    this.values[manifest.id] = next;
    delete this.preservedPlugins[manifest.id];
    for (const [key, value] of Object.entries(next)) {
      if (!previous || !Object.hasOwn(previous, key) ||
        JSON.stringify(previous[key]) !== JSON.stringify(value)) {
        this.emitChange(manifest.id, key, value);
      }
    }
  }

  unregisterPlugin(id: string): void {
    if (id === 'shell') return;
    if (this.values[id]) {
      this.preservedPlugins[id] = structuredClone(this.values[id]);
    }
    this.schemas.delete(id);
    delete this.values[id];
  }

  set(scope: string, key: string, value: Json): Promise<void> {
    const snapshot = structuredClone(value);
    const operation = this.queue.then(async () => {
      this.validate(scope, key, snapshot);
      if (JSON.stringify(this.values[scope]![key]) === JSON.stringify(snapshot)) return;
      const next = this.all();
      next[scope]![key] = snapshot;
      const { shell, ...plugins } = next;
      await this.files.write(join(this.userData, 'settings.json'), {
        shell: shell!,
        plugins: { ...this.preservedPlugins, ...plugins },
      });
      if (this.values[scope]) {
        this.values[scope]![key] = snapshot;
      } else if (scope !== 'shell' && this.preservedPlugins[scope]) {
        this.preservedPlugins[scope]![key] = snapshot;
      }
      this.emitChange(scope, key, snapshot);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  flush(): Promise<void> { return this.queue; }
}
