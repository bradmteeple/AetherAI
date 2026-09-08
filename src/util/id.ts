/**
 * Showdown's `toID`: lowercase, strip everything that is not a-z0-9.
 * Mirrors `sim/dex-data.ts` toID so room ids, usernames and packed names match
 * what the server computes.
 */
export function toID(text: unknown): string {
  if (text === null || text === undefined) return '';
  if (typeof text === 'number') return String(text);
  if (typeof text !== 'string') {
    const anyText = text as { id?: unknown; userid?: unknown; roomid?: unknown };
    if (typeof anyText.id === 'string') return anyText.id;
    if (typeof anyText.userid === 'string') return anyText.userid;
    if (typeof anyText.roomid === 'string') return anyText.roomid;
    return '';
  }
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Strip a leading rank symbol from a `USER` field (`" Name"`, `"@Name"`, `"~"`). */
export function stripRank(user: string): string {
  if (!user) return '';
  const first = user.charAt(0);
  if (/[a-zA-Z0-9]/.test(first)) return user;
  return user.slice(1);
}

/** Remove the `@!` away marker that can be appended to identities. */
export function cleanIdentity(user: string): string {
  return stripRank(user).replace(/@!$/, '').trim();
}
