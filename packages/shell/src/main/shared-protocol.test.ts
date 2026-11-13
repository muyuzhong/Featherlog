import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { SHARED_MODULES, type SharedModuleSpecifier } from './shared-exports';
import { buildSharedShimSource, createSharedProtocolHandler } from './shared-protocol';

const req = createRequire(import.meta.url);

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__FEATHERLOG_SHARED_RUNTIME__;
});

describe('shared runtime protocol', () => {
  it('stays synchronized with every valid named export from installed packages', async () => {
    const entries = Object.entries(SHARED_MODULES) as [SharedModuleSpecifier, { exports: readonly string[] }][];
    for (const [specifier, entry] of entries) {
      const mod = await import(req.resolve(specifier)) as Record<string, unknown>;
      const actual = Object.keys(mod)
        .filter(name => name !== 'default' && name !== '__esModule' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
        .sort();
      expect([...entry.exports].sort()).toEqual(actual);
    }
  });

  it('serves virtual ESM shims for GET/HEAD and rejects invalid requests', async () => {
    const handler = createSharedProtocolHandler();
    expect(handler({ method: 'POST', url: 'featherlog-shared://runtime/react.js' }).status).toBe(405);
    expect(handler({ url: 'not a valid url' }).status).toBe(400);
    expect(handler({ url: 'featherlog-shared://wrong-host/react.js' }).status).toBe(404);
    expect(handler({ url: 'featherlog-shared://runtime/unknown.js' }).status).toBe(404);

    const head = handler({ method: 'HEAD', url: 'featherlog-shared://runtime/react.js' });
    expect(head.status).toBe(200);
    expect(head.headers.get('access-control-allow-origin')).toBe('*');
    expect(await head.text()).toBe('');

    const get = handler({ url: 'featherlog-shared://runtime/react-dom-client.js' });
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/javascript');
    const source = await get.text();
    expect(source).toContain('createRoot');
    expect(source).toContain('hydrateRoot');
  });

  it('executes generated ESM shims against host runtime and errors cleanly if missing', async () => {
    const shimUrl = `data:text/javascript;base64,${Buffer.from(buildSharedShimSource('react/jsx-runtime')).toString('base64')}`;
    await expect(import(shimUrl)).rejects.toThrow('Featherlog shared runtime missing: react/jsx-runtime');

    const fakeJsx = () => 'ok';
    (globalThis as Record<string, unknown>).__FEATHERLOG_SHARED_RUNTIME__ = {
      'react/jsx-runtime': { default: { jsx: fakeJsx }, Fragment: 'frag', jsx: fakeJsx, jsxs: fakeJsx },
    };
    const loaded = await import(`${shimUrl}#loaded`);
    expect(loaded.jsx).toBe(fakeJsx);
    expect(loaded.Fragment).toBe('frag');
    expect(loaded.default).toEqual({ jsx: fakeJsx });
  });
});
