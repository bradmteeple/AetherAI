import { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Origins allowed to call the API from a browser. Entries are exact origins
 * (`https://example.github.io`), a wildcard host (`https://*.github.io`), or
 * `*` for any origin.
 *
 * Cross-origin callers authenticate with a bearer token, never a cookie, so no
 * `Access-Control-Allow-Credentials` is issued and there is no ambient
 * authority for another site to ride on.
 */
export const DEFAULT_ALLOWED_ORIGINS = ['https://*.github.io'];

export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export function originAllowed(origin: string, allowed: string[]): boolean {
  if (!origin) return false;
  for (const entry of allowed) {
    if (entry === '*') return true;
    if (entry === origin) return true;
    const wildcard = /^(https?:\/\/)\*\.(.+)$/.exec(entry);
    if (!wildcard) continue;
    const [, scheme, domain] = wildcard;
    if (origin.startsWith(scheme) && origin.slice(scheme.length).endsWith(`.${domain}`)) return true;
  }
  return false;
}

export function corsHeaders(req: IncomingMessage, allowed: string[]): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !originAllowed(origin, allowed)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** Answer a CORS preflight. Returns true when the request was handled. */
export function handlePreflight(req: IncomingMessage, res: ServerResponse, allowed: string[]): boolean {
  if (req.method !== 'OPTIONS') return false;
  const headers = corsHeaders(req, allowed);
  res.writeHead(headers['access-control-allow-origin'] ? 204 : 403, headers);
  res.end();
  return true;
}
