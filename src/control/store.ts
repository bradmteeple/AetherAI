import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../config';
import { toID } from '../util/id';

/**
 * A Showdown login the bot can use. `password` never leaves the server: the
 * HTTP API only ever exposes {@link PublicAccount}.
 */
export interface StoredAccount {
  id: string;
  username: string;
  password?: string;
  addedAt: string;
  lastUsedAt?: string;
}

export interface PublicAccount {
  id: string;
  username: string;
  hasPassword: boolean;
  addedAt: string;
  lastUsedAt?: string;
  active: boolean;
}

/** Everything the control panel can change about how the bot plays. */
export interface BotSettings {
  serverUrl: string;
  loginUrl: string;
  formatId: string;
  teamFile: string;
  mode: 'challenge' | 'accept';
  opponent: string;
  agent: 'mock' | 'http';
  agentUrl: string;
  timer: boolean;
  /** Keep starting a new set after each one finishes, until switched off. */
  continuous: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ControlState {
  version: 1;
  activeAccountId: string | null;
  accounts: StoredAccount[];
  settings: BotSettings;
}

export class ControlStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ControlStoreError';
  }
}

export function defaultSettings(): BotSettings {
  const cfg = loadConfig();
  return {
    serverUrl: cfg.serverUrl,
    loginUrl: cfg.loginUrl,
    formatId: cfg.formatId,
    teamFile: cfg.teamFile,
    mode: cfg.mode,
    opponent: cfg.opponent ?? '',
    agent: cfg.agent,
    agentUrl: cfg.agentUrl ?? '',
    timer: cfg.timer,
    continuous: true,
    logLevel: cfg.logLevel,
  };
}

const SETTING_KEYS: (keyof BotSettings)[] = [
  'serverUrl', 'loginUrl', 'formatId', 'teamFile', 'mode', 'opponent', 'agent', 'agentUrl', 'timer', 'continuous', 'logLevel',
];

function coerceSettings(raw: unknown, base: BotSettings): BotSettings {
  const patch = (raw ?? {}) as Record<string, unknown>;
  const out: BotSettings = { ...base };
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    switch (key) {
      case 'mode':
        if (value !== 'challenge' && value !== 'accept') throw new ControlStoreError('mode must be "challenge" or "accept"');
        out.mode = value;
        break;
      case 'agent':
        if (value !== 'mock' && value !== 'http') throw new ControlStoreError('agent must be "mock" or "http"');
        out.agent = value;
        break;
      case 'logLevel':
        if (value !== 'debug' && value !== 'info' && value !== 'warn' && value !== 'error') {
          throw new ControlStoreError('logLevel must be debug, info, warn or error');
        }
        out.logLevel = value;
        break;
      case 'timer':
      case 'continuous':
        if (typeof value !== 'boolean') throw new ControlStoreError(`${key} must be a boolean`);
        out[key] = value;
        break;
      default:
        if (typeof value !== 'string') throw new ControlStoreError(`${key} must be a string`);
        out[key] = value.trim();
    }
  }
  if (!out.serverUrl) throw new ControlStoreError('serverUrl is required');
  if (!out.formatId) throw new ControlStoreError('formatId is required');
  if (!out.teamFile) throw new ControlStoreError('teamFile is required');
  return out;
}

/**
 * Accounts + settings for the control panel, persisted to a single JSON file
 * (`.aether/control.json` by default) with owner-only permissions because it
 * holds Showdown passwords.
 */
export class ControlStore {
  readonly file: string;
  private state: ControlState;

  constructor(file = process.env.CONTROL_STATE_FILE || resolve(process.cwd(), '.aether/control.json')) {
    this.file = resolve(file);
    this.state = this.read();
  }

  private read(): ControlState {
    const settings = defaultSettings();
    if (!existsSync(this.file)) return this.seedFromEnv({ version: 1, activeAccountId: null, accounts: [], settings });
    let parsed: Partial<ControlState>;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<ControlState>;
    } catch (err) {
      throw new ControlStoreError(`${this.file} is not valid JSON: ${(err as Error).message}`, 500);
    }
    const accounts = (parsed.accounts ?? [])
      .filter((a): a is StoredAccount => Boolean(a && typeof a.username === 'string' && a.username))
      .map((a) => ({ ...a, id: a.id || toID(a.username) }));
    const activeAccountId = accounts.some((a) => a.id === parsed.activeAccountId) ? parsed.activeAccountId! : accounts[0]?.id ?? null;
    return { version: 1, accounts, activeAccountId, settings: { ...settings, ...(parsed.settings ?? {}) } };
  }

  /** First run: adopt PS_USERNAME/PS_PASSWORD from the environment as account #1. */
  private seedFromEnv(state: ControlState): ControlState {
    const username = (process.env.PS_USERNAME ?? '').trim();
    if (!username) return state;
    const account: StoredAccount = {
      id: toID(username),
      username,
      password: process.env.PS_PASSWORD || undefined,
      addedAt: new Date().toISOString(),
    };
    return { ...state, accounts: [account], activeAccountId: account.id };
  }

  private persist(): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try {
      renameSync(tmp, this.file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
    try { chmodSync(this.file, 0o600); } catch { /* not all filesystems support it */ }
  }

  get settings(): BotSettings {
    return { ...this.state.settings };
  }

  updateSettings(patch: unknown): BotSettings {
    this.state.settings = coerceSettings(patch, this.state.settings);
    this.persist();
    return this.settings;
  }

  listAccounts(): PublicAccount[] {
    return this.state.accounts.map((a) => ({
      id: a.id,
      username: a.username,
      hasPassword: Boolean(a.password),
      addedAt: a.addedAt,
      lastUsedAt: a.lastUsedAt,
      active: a.id === this.state.activeAccountId,
    }));
  }

  get activeAccountId(): string | null {
    return this.state.activeAccountId;
  }

  /** The full account (password included) the bot should log in as. */
  activeAccount(): StoredAccount | null {
    return this.state.accounts.find((a) => a.id === this.state.activeAccountId) ?? null;
  }

  /**
   * Add an account, or update the password of an existing one. Omitting
   * `password` on an existing account keeps the stored one.
   */
  upsertAccount(input: { username?: unknown; password?: unknown; makeActive?: unknown }): PublicAccount {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!username) throw new ControlStoreError('username is required');
    if (username.length > 18) throw new ControlStoreError('Showdown usernames are at most 18 characters');
    const id = toID(username);
    if (!id) throw new ControlStoreError('username must contain at least one letter or digit');
    if (input.password !== undefined && input.password !== null && typeof input.password !== 'string') {
      throw new ControlStoreError('password must be a string');
    }
    const password = typeof input.password === 'string' ? input.password : undefined;
    const existing = this.state.accounts.find((a) => a.id === id);
    if (existing) {
      existing.username = username;
      if (password !== undefined) existing.password = password || undefined;
    } else {
      this.state.accounts.push({ id, username, password: password || undefined, addedAt: new Date().toISOString() });
    }
    if (input.makeActive !== false || !this.state.activeAccountId) this.state.activeAccountId = id;
    this.persist();
    return this.listAccounts().find((a) => a.id === id)!;
  }

  removeAccount(id: string): void {
    const index = this.state.accounts.findIndex((a) => a.id === id);
    if (index < 0) throw new ControlStoreError(`No account "${id}"`, 404);
    this.state.accounts.splice(index, 1);
    if (this.state.activeAccountId === id) this.state.activeAccountId = this.state.accounts[0]?.id ?? null;
    this.persist();
  }

  setActiveAccount(id: string): PublicAccount {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new ControlStoreError(`No account "${id}"`, 404);
    this.state.activeAccountId = id;
    this.persist();
    return this.listAccounts().find((a) => a.id === id)!;
  }

  markAccountUsed(id: string): void {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) return;
    account.lastUsedAt = new Date().toISOString();
    this.persist();
  }
}
