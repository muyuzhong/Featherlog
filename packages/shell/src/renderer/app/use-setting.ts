import type { Json } from '@featherlog/contracts';
import { useEffect, useState } from 'react';
import type { WindowRuntime } from './runtime';

/** A setting that re-renders when it changes (in this window or any other). */
export function useSetting<T extends Json>(runtime: WindowRuntime, scope: string, key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => runtime.setting<T>(scope, key));
  useEffect(
    () => runtime.onSettingChange((s, k, v) => s === scope && k === key && setValue(v as T)),
    [runtime, scope, key],
  );
  return value;
}
