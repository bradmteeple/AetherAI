/** Shared helpers: tiny DOM utilities, API calls, and saved-team storage. */

export const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid);
  }
  return node;
};

/** replaceChildren renders a literal "null" for empty slots; this drops them. */
export const setKids = (node, ...kids) =>
  node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.problems = data.problems;
    throw err;
  }
  return data;
}

export const typeClass = (type) => `type t-${String(type).toLowerCase()}`;

/** Saved teams live in this browser; nothing leaves the machine. */
const STORE_KEY = 'aether.teams';

export function loadTeams() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTeams(teams) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(teams.slice(0, 40)));
    return true;
  } catch {
    return false;
  }
}

export function toast(message, kind = '') {
  let host = $('#toast');
  if (!host) {
    host = el('div', { id: 'toast' });
    document.body.append(host);
  }
  host.textContent = message;
  host.className = `toast show ${kind}`;
  clearTimeout(host._timer);
  host._timer = setTimeout(() => { host.className = 'toast'; }, 3600);
}
