import type { BusError, BusErrorInfo, Json, KernelErrorCode } from '@featherlog/contracts';

export function kernelError(code: KernelErrorCode, message: string): BusError {
  return Object.assign(new Error(message), { code });
}

export function handlerError(value: unknown): BusErrorInfo {
  if (
    value instanceof Error &&
    'code' in value &&
    typeof value.code === 'string' &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.code)
  ) {
    return {
      code: value.code,
      message: value.message,
      ...('data' in value && value.data !== undefined ? { data: value.data as Json } : {}),
    };
  }
  return {
    code: 'handler-error',
    message: value instanceof Error ? value.message : String(value),
  };
}

function notJson(): never {
  throw kernelError('not-json', 'Message data must be pure JSON');
}

export function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) return notJson();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array && prototype !== Array.prototype) return notJson();
  if (!array && prototype !== Object.prototype && prototype !== null) return notJson();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return notJson();
  ancestors.add(value);
  // The key count plus an own data property at every index excludes holes and extra keys.
  for (let index = 0; index < (array ? value.length : keys.length); index++) {
    const key = array ? index : keys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if ((!array && typeof key !== 'string') || !descriptor?.enumerable || !('value' in descriptor)) {
      return notJson();
    }
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

export function freeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  // Freeze before recursing so production-mode cyclic input cannot loop forever.
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

export function snapshot<T>(value: T, development: boolean): T {
  try {
    if (development) assertJson(value);
    const copy = structuredClone(value);
    freeze(copy);
    return copy;
  } catch {
    throw kernelError('not-json', 'Message data must be cloneable JSON');
  }
}
