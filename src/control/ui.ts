/**
 * The control panel, served as one self-contained page (no build step, no CDN)
 * by {@link createControlServer}.
 */
export const CONTROL_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<title>AetherAI control</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1017; --panel: #161b26; --panel-2: #1d2431; --line: #2a3242;
    --text: #e6e9ef; --muted: #97a1b4; --accent: #63b3ff; --on: #37d67a; --off: #6b7686;
    --warn: #f2b544; --err: #ff6b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 24px 20px 8px; max-width: 980px; margin: 0 auto; }
  header h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  main { max-width: 980px; margin: 0 auto; padding: 12px 20px 60px;
    display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 18px; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 0 0 14px; font-weight: 600; }
  .power { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--off); flex: none; }
  .dot.online { background: var(--on); box-shadow: 0 0 0 4px rgba(55,214,122,.18); }
  .dot.starting, .dot.stopping { background: var(--warn); }
  .dot.error { background: var(--err); }
  .state { font-size: 22px; font-weight: 650; }
  .state small { display: block; font-size: 12px; font-weight: 400; color: var(--muted); }
  button { font: inherit; border-radius: 8px; border: 1px solid var(--line);
    background: var(--panel-2); color: var(--text); padding: 8px 14px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.primary { background: var(--on); border-color: var(--on); color: #06240f; font-weight: 650; }
  button.danger { background: #3a1f24; border-color: #5a2a31; color: #ffc9c9; }
  button.big { padding: 12px 26px; font-size: 16px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 0 0 4px; }
  input, select { width: 100%; font: inherit; color: var(--text); background: #10141d;
    border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
  .row { display: flex; gap: 10px; align-items: center; }
  .check { display: flex; gap: 8px; align-items: center; color: var(--text); font-size: 14px; }
  .check input { width: auto; }
  ul.accounts { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
  ul.accounts li { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--panel-2); }
  ul.accounts li.active { border-color: var(--accent); }
  ul.accounts .name { font-weight: 600; }
  ul.accounts .meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
  ul.accounts .spacer { flex: 1; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; white-space: nowrap;
    padding: 2px 8px; border-radius: 99px; background: rgba(99,179,255,.15); color: var(--accent); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; font-size: 14px; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  pre#log { margin: 0; height: 260px; overflow: auto; background: #0a0d14; border: 1px solid var(--line);
    border-radius: 8px; padding: 12px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #c8d2e0; white-space: pre-wrap; word-break: break-word; }
  .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 24px; max-width: 90vw;
    padding: 10px 16px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line);
    font-size: 14px; display: none; }
  .toast.err { border-color: var(--err); color: #ffd7d7; }
  .toast.show { display: block; }
  .hint { color: var(--muted); font-size: 12px; margin: 10px 0 0; }
  .gate { position: fixed; inset: 0; display: grid; place-items: center; padding: 20px; background: var(--bg); z-index: 10; }
  .gate-card { width: 100%; max-width: 360px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 26px; }
  .gate-card h1 { font-size: 19px; margin: 0 0 6px; }
  .gate-card p.sub { margin: 0 0 18px; color: var(--muted); font-size: 13px; }
  .gate-card button { width: 100%; margin-top: 14px; }
  .gate-error { color: var(--err); font-size: 13px; margin: 12px 0 0; min-height: 18px; }
  header .bar { display: flex; align-items: baseline; gap: 12px; }
  header .bar .spacer { flex: 1; }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; } .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="gate" id="gate" hidden>
  <form class="gate-card" id="loginForm">
    <h1>AetherAI control</h1>
    <p class="sub">Sign in to turn the bot on or off.</p>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required />
    <button type="submit" class="primary">Sign in</button>
    <p class="gate-error" id="loginError"></p>
  </form>
</div>
<div id="app" hidden>
<header>
  <div class="bar">
    <h1>AetherAI control</h1>
    <span class="spacer"></span>
    <button type="button" id="btnLogout" hidden>Sign out</button>
  </div>
  <p id="formatName">Pokémon Showdown connector</p>
</header>
<main>
  <section class="wide">
    <h2>Power</h2>
    <div class="power">
      <span class="dot" id="dot"></span>
      <div class="state" id="stateText">…<small id="stateSub">loading</small></div>
      <div class="spacer" style="flex:1"></div>
      <button class="big primary" id="btnOn">Turn on</button>
      <button class="big danger" id="btnOff">Turn off</button>
    </div>
    <p class="hint" id="powerHint"></p>
  </section>

  <section>
    <h2>Account</h2>
    <ul class="accounts" id="accounts"></ul>
    <form id="accountForm">
      <div class="grid">
        <div><label for="newUsername">Showdown username</label><input id="newUsername" maxlength="18" autocomplete="username" required /></div>
        <div><label for="newPassword">Password (blank if unregistered)</label><input id="newPassword" type="password" autocomplete="new-password" /></div>
      </div>
      <div class="row" style="margin-top:12px">
        <button type="submit">Save account &amp; use it</button>
      </div>
    </form>
    <p class="hint">Passwords are stored on this machine only (<code id="storeFile">.aether/control.json</code>, owner-readable) and are never sent back to the browser.</p>
  </section>

  <section>
    <h2>Status</h2>
    <dl>
      <dt>Logged in as</dt><dd id="stLogin">—</dd>
      <dt>Connection</dt><dd id="stConn">—</dd>
      <dt>Current set</dt><dd id="stSet">—</dd>
      <dt>Record</dt><dd id="stTotals">—</dd>
      <dt>Last set</dt><dd id="stLast">—</dd>
      <dt>Last error</dt><dd id="stErr">—</dd>
    </dl>
  </section>

  <section class="wide">
    <h2>Settings</h2>
    <form id="settingsForm">
      <div class="grid">
        <div><label for="mode">Mode</label><select id="mode"><option value="challenge">Challenge someone</option><option value="accept">Accept challenges</option></select></div>
        <div><label for="opponent">Opponent (required to challenge; optional filter when accepting)</label><input id="opponent" maxlength="18" /></div>
        <div><label for="agent">Battle agent</label><select id="agent"><option value="mock">Mock (random legal play)</option><option value="http">HTTP agent</option></select></div>
        <div><label for="agentUrl">Agent URL</label><input id="agentUrl" placeholder="http://127.0.0.1:8787" /></div>
        <div><label for="teamFile">Team file</label><input id="teamFile" /></div>
        <div><label for="formatId">Format id</label><input id="formatId" /></div>
        <div><label for="serverUrl">Server WebSocket URL</label><input id="serverUrl" /></div>
        <div><label for="loginUrl">Login API URL</label><input id="loginUrl" /></div>
        <div><label for="logLevel">Log level</label><select id="logLevel"><option>debug</option><option>info</option><option>warn</option><option>error</option></select></div>
        <div style="display:flex;gap:18px;align-items:flex-end;padding-bottom:6px">
          <label class="check"><input type="checkbox" id="timer" /> Battle timer on</label>
          <label class="check"><input type="checkbox" id="continuous" /> Keep playing sets</label>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button type="submit">Save settings</button>
        <span class="hint" id="settingsHint"></span>
      </div>
    </form>
  </section>

  <section class="wide">
    <h2>Log</h2>
    <pre id="log">waiting for the bot…</pre>
  </section>
</main>
</div>
<div class="toast" id="toast"></div>
<script>
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var logSeq = 0;
  var busy = false;
  var settingsDirty = false;

  function api(path, options) {
    options = options || {};
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch('/api' + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('HTTP ' + res.status));
          err.status = res.status;
          err.needsPassword = !!data.needsPassword;
          throw err;
        }
        return data;
      });
    });
  }

  var authed = false;

  function showGate(message) {
    authed = false;
    document.getElementById('gate').hidden = false;
    document.getElementById('app').hidden = true;
    document.getElementById('loginError').textContent = message || '';
    var field = document.getElementById('password');
    field.value = '';
    field.focus();
  }

  function showApp(needsPassword) {
    authed = true;
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    document.getElementById('btnLogout').hidden = !needsPassword;
    refresh();
    pollLogs();
  }

  /** Any 401 while signed in means the session lapsed: back to the login screen. */
  function handle(err) {
    if (err && err.status === 401 && err.needsPassword) {
      showGate('Your session expired — sign in again.');
      return;
    }
    toast(err.message, true);
  }

  var toastTimer;
  function toast(message, isError) {
    var el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 4000);
  }

  function text(id, value) { document.getElementById(id).textContent = value; }

  function renderStatus(s) {
    document.getElementById('dot').className = 'dot ' + s.status;
    var labels = { off: 'Off', starting: 'Starting…', online: 'On', stopping: 'Stopping…', error: 'Error' };
    document.getElementById('stateText').firstChild.nodeValue = labels[s.status] || s.status;
    var who = s.account ? ' as ' + s.account.username : '';
    text('stateSub', 'since ' + new Date(s.since).toLocaleTimeString() + who);
    document.getElementById('btnOn').disabled = busy || s.status === 'online' || s.status === 'starting' || s.status === 'stopping';
    document.getElementById('btnOff').disabled = busy || s.status === 'off' || s.status === 'stopping';
    text('stLogin', s.loggedInAs || '—');
    text('stConn', s.connection);
    text('stSet', s.currentSet
      ? 'game ' + s.currentSet.game + ' vs ' + (s.currentSet.opponent || '?') + ' — ' + s.currentSet.score + ' (' + s.currentSet.phase + ')'
      : '—');
    text('stTotals', s.totals.sets + ' sets · ' + s.totals.wins + 'W ' + s.totals.losses + 'L ' + s.totals.ties + 'T');
    text('stLast', s.lastSet ? (s.lastSet.result || 'unfinished') + ' ' + s.lastSet.score + ' vs ' + (s.lastSet.opponent || '?') : '—');
    text('stErr', s.lastError || '—');
    var hint = '';
    if (s.status === 'off') hint = 'The bot is not connected to Showdown.';
    if (s.status === 'online') hint = 'Connected and playing. Settings and account changes apply after the next restart.';
    text('powerHint', hint);
  }

  function renderAccounts(accounts, botOff) {
    var list = document.getElementById('accounts');
    list.innerHTML = '';
    if (!accounts.length) {
      var empty = document.createElement('li');
      empty.className = 'meta';
      empty.textContent = 'No accounts yet — add one below.';
      list.appendChild(empty);
      return;
    }
    accounts.forEach(function (a) {
      var li = document.createElement('li');
      if (a.active) li.className = 'active';

      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'account';
      radio.checked = a.active;
      radio.disabled = !botOff;
      radio.style.width = 'auto';
      radio.title = botOff ? 'Log in with this account' : 'Turn the bot off to switch accounts';
      radio.onchange = function () { setActive(a.id); };
      li.appendChild(radio);

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = a.username;
      li.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = a.hasPassword ? 'password saved' : 'no password';
      li.appendChild(meta);

      if (a.active) {
        var badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'in use';
        li.appendChild(badge);
      }

      var spacer = document.createElement('span');
      spacer.className = 'spacer';
      li.appendChild(spacer);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Remove';
      del.disabled = a.active && !botOff;
      del.onclick = function () {
        if (!confirm('Remove ' + a.username + '?')) return;
        api('/accounts/delete', { method: 'POST', body: { id: a.id } })
          .then(function () { toast(a.username + ' removed'); return refresh(); })
          .catch(handle);
      };
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  var FIELDS = ['mode', 'opponent', 'agent', 'agentUrl', 'teamFile', 'formatId', 'serverUrl', 'loginUrl', 'logLevel'];
  var CHECKS = ['timer', 'continuous'];

  function renderSettings(settings) {
    if (settingsDirty) return;
    FIELDS.forEach(function (id) { document.getElementById(id).value = settings[id] == null ? '' : settings[id]; });
    CHECKS.forEach(function (id) { document.getElementById(id).checked = !!settings[id]; });
  }

  function readSettings() {
    var out = {};
    FIELDS.forEach(function (id) { out[id] = document.getElementById(id).value; });
    CHECKS.forEach(function (id) { out[id] = document.getElementById(id).checked; });
    return out;
  }

  function setActive(id) {
    api('/accounts/active', { method: 'POST', body: { id: id } })
      .then(function () { toast('Account switched'); return refresh(); })
      .catch(function (err) { handle(err); refresh(); });
  }

  function power(on) {
    busy = true;
    refresh();
    api('/power', { method: 'POST', body: { on: on } })
      .then(function () { toast(on ? 'Bot turned on' : 'Bot turned off'); })
      .catch(handle)
      .then(function () { busy = false; return refresh(); });
  }

  function refresh() {
    if (!authed) return Promise.resolve();
    return api('/config').then(function (data) {
      renderStatus(data.status);
      var botOff = data.status.status === 'off' || data.status.status === 'error';
      renderAccounts(data.accounts, botOff);
      renderSettings(data.settings);
      text('formatName', data.format.name + '  ·  ' + data.format.id);
      document.title = 'AetherAI — ' + data.status.status;
    }).catch(handle);
  }

  function pollLogs() {
    if (!authed) return;
    api('/logs?after=' + logSeq).then(function (data) {
      if (!data.lines.length) return;
      logSeq = data.latest;
      var pre = document.getElementById('log');
      if (pre.dataset.empty !== 'no') { pre.textContent = ''; pre.dataset.empty = 'no'; }
      var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      data.lines.forEach(function (l) { pre.textContent += l.line + '\\n'; });
      var lines = pre.textContent.split('\\n');
      if (lines.length > 600) pre.textContent = lines.slice(lines.length - 600).join('\\n');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    }).catch(function () { /* transient */ });
  }

  document.getElementById('btnOn').onclick = function () { power(true); };
  document.getElementById('btnOff').onclick = function () { power(false); };

  document.getElementById('accountForm').onsubmit = function (event) {
    event.preventDefault();
    var username = document.getElementById('newUsername').value.trim();
    var password = document.getElementById('newPassword').value;
    if (!username) return;
    api('/accounts', { method: 'POST', body: { username: username, password: password } })
      .then(function () {
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        toast('Saved ' + username);
        return refresh();
      })
      .catch(handle);
  };

  FIELDS.concat(CHECKS).forEach(function (id) {
    document.getElementById(id).addEventListener('input', function () { settingsDirty = true; });
  });

  document.getElementById('settingsForm').onsubmit = function (event) {
    event.preventDefault();
    api('/settings', { method: 'POST', body: readSettings() })
      .then(function (data) {
        settingsDirty = false;
        toast(data.applied ? 'Settings saved' : 'Saved — they apply the next time the bot is turned on');
        return refresh();
      })
      .catch(handle);
  };

  document.getElementById('loginForm').onsubmit = function (event) {
    event.preventDefault();
    var button = event.target.querySelector('button');
    button.disabled = true;
    api('/login', { method: 'POST', body: { password: document.getElementById('password').value } })
      .then(function () { document.getElementById('loginError').textContent = ''; showApp(true); })
      .catch(function (err) { document.getElementById('loginError').textContent = err.message; })
      .then(function () { button.disabled = false; });
  };

  document.getElementById('btnLogout').onclick = function () {
    api('/logout', { method: 'POST' })
      .catch(function () { /* the cookie is gone either way */ })
      .then(function () { showGate('Signed out.'); });
  };

  api('/session')
    .then(function (session) {
      if (session.authenticated) return showApp(session.needsPassword);
      showGate(session.needsPassword ? '' : 'This panel is protected by a token — open it with the ?token=… link printed at startup.');
      document.getElementById('password').disabled = !session.needsPassword;
    })
    .catch(function (err) { showGate(err.message); });

  setInterval(refresh, 2000);
  setInterval(pollLogs, 1500);
})();
</script>
</body>
</html>
`;

/** Tab icon: an "A" mark that turns green while the bot is on is overkill; a static mark is enough. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#161b26"/>
<path d="M16 6 L25 26 H20.6 L16 15.2 L11.4 26 H7 Z" fill="#63b3ff"/>
</svg>
`;
