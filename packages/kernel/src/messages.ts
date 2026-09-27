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

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  const fail = () => {
    throw kernelError('not-json', 'Message data must be pure JSON');
  };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) return fail();
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array && prototype !== Array.prototype) return fail();
  if (!array && prototype !== Object.prototype && prototype !== null) return fail();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return fail();
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) {
      return fail();
    }
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return fail();
    assertJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

function freeze(value: unknown): void {
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
