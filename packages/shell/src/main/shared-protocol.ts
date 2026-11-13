import { SHARED_MODULES, type SharedModuleSpecifier } from './shared-exports';

export const SHARED_PROTOCOL = 'featherlog-shared';
export const SHARED_HOST = 'runtime';

const SLUG_TO_SPECIFIER = new Map<string, SharedModuleSpecifier>(
  (Object.entries(SHARED_MODULES) as [SharedModuleSpecifier, { slug: string }][]).map(
    ([specifier, entry]) => [entry.slug, specifier],
  ),
);

/**
 * Emits a virtual ESM shim backed by the host renderer's singleton module table so
 * external plugins never instantiate a duplicate React copy across origins.
 */
export function buildSharedShimSource(specifier: SharedModuleSpecifier): string {
  const { exports: names } = SHARED_MODULES[specifier];
  return [
    'const rt = globalThis.__FEATHERLOG_SHARED_RUNTIME__;',
    `const mod = rt && rt[${JSON.stringify(specifier)}];`,
    `if (!mod) throw new Error(${JSON.stringify(`Featherlog shared runtime missing: ${specifier}`)});`,
    'export default mod.default ?? mod;',
    `export const {\n  ${names.join(',\n  ')},\n} = mod;`,
    '',
  ].join('\n');
}

export interface ProtocolRequestLike {
  method?: string;
  url: string;
}

export function createSharedProtocolHandler(): (request: ProtocolRequestLike) => Response {
  return (request: ProtocolRequestLike) => {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (url.protocol !== `${SHARED_PROTOCOL}:` || url.hostname !== SHARED_HOST) {
      return new Response('Not Found', { status: 404 });
    }
    const slug = url.pathname.replace(/^\/+/, '');
    const specifier = SLUG_TO_SPECIFIER.get(slug);
    if (!specifier) {
      return new Response('Not Found', { status: 404 });
    }
    const body = method === 'HEAD' ? null : buildSharedShimSource(specifier);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/javascript; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    });
  };
}
