import React, * as ReactNs from 'react';
import ReactDOM, * as ReactDOMNs from 'react-dom';
import ReactDOMClient, * as ReactDOMClientNs from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as MotionReact from 'motion/react';

function normalizeModule(mod: object, fallbackDefault?: unknown): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.create(null);
  const recordMod = mod as Record<string, unknown>;
  const def = fallbackDefault
    ?? (recordMod.default && (typeof recordMod.default === 'object' || typeof recordMod.default === 'function')
      ? recordMod.default
      : undefined);
  if (def && typeof def === 'object') {
    Object.assign(normalized, def);
  }
  Object.assign(normalized, recordMod);
  if (def !== undefined) {
    normalized.default = def;
  }
  return Object.freeze(normalized);
}

const sharedRuntime = Object.freeze({
  react: normalizeModule(ReactNs, React),
  'react-dom': normalizeModule(ReactDOMNs, ReactDOM),
  'react-dom/client': normalizeModule(ReactDOMClientNs, ReactDOMClient),
  'react/jsx-runtime': normalizeModule(ReactJsxRuntime),
  'motion/react': normalizeModule(MotionReact),
});

Object.defineProperty(globalThis, '__FEATHERLOG_SHARED_RUNTIME__', {
  value: sharedRuntime,
  configurable: false,
  writable: false,
  enumerable: false,
});
