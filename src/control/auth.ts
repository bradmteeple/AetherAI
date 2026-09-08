import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'aether_session';
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_FAILURES = 5;
const BASE_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

export interface AuthOptions {
  /** Admin password for the browser login (`CONTROL_PASSWORD`). */
  password?: string;
  /** Shared secret for scripts (`CONTROL_TOKEN`): `Authorization: Bearer …` or `?token=`. */
  token?: string;
  now?: () => number;
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 429; error: string; needsPassword: boolean; retryAfterSec?: number };

function equal(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** The address to rate-limit on, honouring the proxy headers Fly/Render set. */
export function clientIp(req: IncomingMessage): string {
  const fly = req.headers['fly-client-ip'];
  if (typeof fly === 'string' && fly) return fly;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/** True when the request reached us over HTTPS (directly or via a TLS-terminating proxy). */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto) return proto.split(',')[0].trim() === 'https';
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

/**
 * Password login for the browser, bearer token for scripts.
 *
 * Sessions are stateless: a cookie carrying an expiry, a nonce and an HMAC
 * keyed by material derived from the password, so restarts keep people logged
 * in but changing the password logs everyone out. Failed logins are rate
 * limited per client address with an exponential lockout.
 */
export class Auth {
  readonly hasPassword: boolean;
  readonly hasToken: boolean;
  private readonly password: string | null;
  private readonly token: string | null;
  private readonly key: Buffer | null;
  private readonly now: () => number;
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(options: AuthOptions = {}) {
    this.password = options.password || null;
    this.token = options.token || null;
    this.hasPassword = Boolean(this.password);
    this.hasToken = Boolean(this.token);
    this.now = options.now ?? Date.now;
    this.key = this.password ? scryptSync(this.password, 'aether-control-session', 32) : null;
  }

  /** No password and no token: every request is allowed (loopback-only use). */
  get open(): boolean {
    return !this.hasPassword && !this.hasToken;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key!).update(payload).digest('base64url');
  }

  private issueSession(): { value: string; expiresAt: number } {
    const expiresAt = this.now() + SESSION_TTL_MS;
    const payload = `${expiresAt}.${randomBytes(12).toString('base64url')}`;
    return { value: `v1.${payload}.${this.sign(payload)}`, expiresAt };
  }

  validSession(value: string | null): boolean {
    if (!value || !this.key) return false;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const [, expiresAt, nonce, mac] = parts;
    if (!equal(mac, this.sign(`${expiresAt}.${nonce}`))) return false;
    return Number(expiresAt) > this.now();
  }

  private lockout(ip: string): number {
    const entry = this.failures.get(ip);
    if (!entry) return 0;
    const remaining = entry.until - this.now();
    return remaining > 0 ? remaining : 0;
  }

  private recordFailure(ip: string): void {
    const entry = this.failures.get(ip) ?? { count: 0, until: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      const over = entry.count - MAX_FAILURES;
      entry.until = this.now() + Math.min(BASE_LOCKOUT_MS * 2 ** over, MAX_LOCKOUT_MS);
    }
    this.failures.set(ip, entry);
  }

  /**
   * Check the password and mint a session cookie value. Throws a message meant
   * for the login form when the password is wrong or the client is locked out.
   */
  login(password: unknown, ip: string): { cookie: string; expiresAt: number } {
    if (!this.hasPassword) throw new AuthError('This panel has no password configured', 400);
    const locked = this.lockout(ip);
    if (locked > 0) {
      throw new AuthError(`Too many attempts — try again in ${Math.ceil(locked / 1000)}s`, 429, Math.ceil(locked / 1000));
    }
    if (typeof password !== 'string' || !equal(password, this.password!)) {
      this.recordFailure(ip);
      throw new AuthError('Wrong password', 401);
    }
    this.failures.delete(ip);
    const session = this.issueSession();
    return { cookie: session.value, expiresAt: session.expiresAt };
  }

  /** Decide whether a request may touch the API. */
  check(req: IncomingMessage, url: URL): AuthResult {
    if (this.open) return { ok: true };
    const presented = bearerToken(req) ?? url.searchParams.get('token');
    if (this.hasToken && presented && equal(presented, this.token!)) return { ok: true };
    if (this.hasPassword) {
      // Cookie for the panel served from this server, bearer for a front-end on
      // another origin (GitHub Pages), which cannot use cookies safely.
      if (this.validSession(readCookie(req, SESSION_COOKIE))) return { ok: true };
      if (presented && this.validSession(presented)) return { ok: true };
    }
    if (this.hasPassword) {
      return { ok: false, status: 401, error: 'Sign in to use the control panel', needsPassword: true };
    }
    return { ok: false, status: 401, error: 'Unauthorized — open the panel with the ?token= link printed at startup', needsPassword: false };
  }

  cookieHeader(value: string, req: IncomingMessage, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)): string {
    const flags = [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAgeSec}`,
    ];
    if (isSecureRequest(req)) flags.push('Secure');
    return flags.join('; ');
  }

  clearCookieHeader(req: IncomingMessage): string {
    return this.cookieHeader('', req, 0);
  }
}

export class AuthError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 429, readonly retryAfterSec?: number) {
    super(message);
    this.name = 'AuthError';
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
