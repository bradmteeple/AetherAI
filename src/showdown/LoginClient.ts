import { toID } from '../util/id';

/**
 * Implements the `|challstr|` login flow documented in PROTOCOL.md:
 *
 *   registered:   POST {loginUrl}login  name=&pass=&challstr=  → "]{json}"  → data.assertion
 *   unregistered: GET  {loginUrl}getassertion?userid=&challstr= → assertion text
 *
 * An assertion starting with ';' is an error (";;message").
 */
export interface LoginClientOptions {
  /** Base URL ending in `/api/`, e.g. `https://play.pokemonshowdown.com/api/`. */
  loginUrl: string;
  fetchImpl?: typeof fetch;
}

export class LoginError extends Error {}

export class LoginClient {
  private readonly loginUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LoginClientOptions) {
    this.loginUrl = options.loginUrl.endsWith('/') ? options.loginUrl : options.loginUrl + '/';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getAssertion(username: string, password: string | undefined, challstr: string): Promise<string> {
    if (password) {
      const body = new URLSearchParams({ name: username, pass: password, challstr });
      const res = await this.fetchImpl(this.loginUrl + 'login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      });
      const text = await res.text();
      if (!text.startsWith(']')) {
        throw new LoginError(`Unexpected login response (${res.status}): ${text.slice(0, 200)}`);
      }
      let data: { actionsuccess?: boolean; assertion?: string; curuser?: { loggedin?: boolean } };
      try {
        data = JSON.parse(text.slice(1));
      } catch (err) {
        throw new LoginError(`Could not parse login response: ${(err as Error).message}`);
      }
      const assertion = data.assertion ?? '';
      if (!data.actionsuccess || !assertion) {
        throw new LoginError(`Login failed for ${username}: wrong password or unregistered name`);
      }
      LoginClient.assertOk(assertion);
      return assertion;
    }

    const url = `${this.loginUrl}getassertion?userid=${encodeURIComponent(toID(username))}&challstr=${encodeURIComponent(challstr)}`;
    const res = await this.fetchImpl(url, { method: 'GET' });
    const assertion = (await res.text()).trim();
    if (!assertion) throw new LoginError(`Empty assertion for ${username}`);
    LoginClient.assertOk(assertion);
    return assertion;
  }

  static assertOk(assertion: string): void {
    if (assertion.startsWith(';')) {
      const msg = assertion.replace(/^;+/, '').trim();
      throw new LoginError(msg || 'Login rejected by the login server');
    }
  }
}
