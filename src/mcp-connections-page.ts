export const mcpConnectionsPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MCP 连接 · Kada</title>
  <style>
    :root { color:#172727; background:#f6f7f3; font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; padding:clamp(16px,5vw,44px); }
    main { max-width:820px; margin:auto; }
    h1 { margin:0 0 16px; font-size:clamp(1.45rem,4vw,2rem); }
    section { background:#fff; border:1px solid #dce3da; border-radius:10px; padding:clamp(14px,4vw,22px); }
    section + section { margin-top:12px; }
    h2 { margin:0 0 8px; font-size:1.05rem; }
    label, legend { font-weight:650; }
    select, textarea { width:100%; min-inline-size:0; margin-top:6px; padding:8px; font:inherit; border:1px solid #a9bcb4; border-radius:6px; background:#fff; color:inherit; }
    textarea { min-height:7rem; resize:vertical; }
    button { padding:7px 11px; border:1px solid #bacbc2; border-radius:6px; background:#fff; color:#175749; font:inherit; cursor:pointer; }
    button.primary { background:#146857; color:#fff; border-color:#146857; font-weight:650; }
    button:disabled { opacity:.55; cursor:default; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:2px solid #146857; outline-offset:3px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
    fieldset { margin:12px 0 0; border:1px solid #dce3da; border-radius:6px; min-inline-size:0; }
    fieldset label { display:block; margin:6px 0; overflow-wrap:anywhere; font-weight:400; }
    #connection-status, #status { color:#3e5951; overflow-wrap:anywhere; }
    #status.error { color:#a32b28; }
    a { color:#146857; }
  </style>
</head>
<body>
<main>
  <h1>MCP 连接</h1>
  <section id="register" aria-label="保存连接定义" hidden>
    <form id="definition-form">
      <label for="definition">连接定义 JSON</label>
      <textarea id="definition" required spellcheck="false" placeholder='{"id":"example","transport":"http","url":"http://127.0.0.1:8080/mcp"}'></textarea>
      <div class="actions"><button type="submit" class="primary" id="register-button">保存连接定义</button></div>
    </form>
  </section>
  <section id="connections" hidden aria-label="已登记连接">
    <label for="connection">连接</label>
    <select id="connection"></select>
    <p id="connection-status"></p>
    <div class="actions" id="connection-actions"></div>
    <div id="tools"></div>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
  <a id="authorization" target="_blank" rel="noopener noreferrer" hidden>继续 OAuth 登录</a>
</main>
<script nonce="__MCP_CONNECTIONS_NONCE__">
const field = id => document.getElementById(id);
const picker = field('connection'), definition = field('definition'), status = field('status');
const authorization = field('authorization'), key = 'kada-mcp-connections-session';
let token, rows = [], busy = false;

async function request(path, method = 'GET', input) {
  const response = await fetch('/mcp-connections/' + path, { method, headers: {
    ...(token ? {Authorization:'Bearer ' + token} : {}), ...(input ? {'Content-Type':'application/json'} : {}),
  }, ...(input ? {body:JSON.stringify(input)} : {}) });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(key);
    throw new Error(body.error || '连接设置请求失败');
  }
  return body;
}

async function perform(work, progress) {
  if (busy) return;
  busy = true;
  const before = rows;
  const controls = document.querySelectorAll('button,select,textarea,input');
  const disabled = Array.from(controls, element => element.disabled);
  for (const element of controls) element.disabled = true;
  authorization.hidden = true;
  status.classList.remove('error');
  status.textContent = progress;
  try { await work(); }
  catch (error) { status.classList.add('error'); status.textContent = error.message; }
  finally {
    busy = false;
    controls.forEach((element, index) => { element.disabled = disabled[index]; });
    if (rows !== before) renderDetail();
  }
}

function button(parent, text, run, disabled = false) {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = text;
  control.disabled = busy || disabled;
  control.addEventListener('click', run);
  parent.append(control);
}

function showAuthorization(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) {
    throw new Error('登录地址无效。');
  }
  authorization.href = url.href;
  authorization.hidden = false;
}

function renderDetail() {
  const connection = rows.find(row => row.id === picker.value);
  const actions = field('connection-actions'), tools = field('tools');
  actions.replaceChildren();
  tools.replaceChildren();
  field('connection-status').textContent = connection
    ? (connection.enabled ? '已启用' : '已停用') + ' · ' + connection.transport + (connection.oauth?.credentialsSaved ? ' · 已登录' : '')
    : '当前没有连接。';
  if (!connection) return;
  const path = 'connections/' + encodeURIComponent(connection.id) + '/';
  const change = (action, input, ok) => void perform(async () => {
    const result = await request(path + action, 'POST', input);
    await refresh(connection.id);
    if (action === 'test' && result.test?.status === 'failed') throw new Error(result.test.message || '连接测试失败。');
    if (action === 'login') showAuthorization(result.authorizationUrl);
    status.textContent = ok;
  }, '正在处理连接');
  button(actions, '测试连接', () => change('test', undefined, '连接测试通过'));
  button(actions, '停用连接', () => change('disable', undefined, '已停用连接'), !connection.enabled);
  button(actions, '刷新连接', () => void perform(async () => {
    await refresh(connection.id);
    status.textContent = '连接状态已刷新';
  }, '正在刷新'));
  if (connection.oauth) {
    button(actions, '发起 OAuth 登录', () => change('login', undefined, '请打开登录链接'));
    button(actions, '退出登录', () => change('logout', undefined, '已退出登录'), !connection.oauth.credentialsSaved);
  }
  if (connection.test?.status !== 'ok') return;
  const discovered = connection.test.tools ?? [];
  const group = document.createElement('fieldset'), legend = document.createElement('legend');
  legend.textContent = '已发现工具';
  group.append(legend);
  const checks = [];
  for (const tool of discovered) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = connection.allowedTools.includes(tool.name);
    input.disabled = busy;
    label.append(input, tool.name);
    group.append(label);
    checks.push({ name: tool.name, input });
  }
  tools.append(group);
  button(tools, '保存启用工具', () => change('enable', { revision:connection.revision,
    tools:checks.filter(entry => entry.input.checked).map(entry => entry.name) }, '已保存启用工具'), !checks.length);
  if (!connection.enabled || !connection.allowedTools.length) return;
  const approved = document.createElement('fieldset'), heading = document.createElement('legend'), choices = [];
  heading.textContent = '单次批准';
  approved.append(heading);
  for (const name of connection.allowedTools) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = (connection.approvalTools ?? []).includes(name);
    input.disabled = busy;
    label.append(input, name + ' 每次执行前批准');
    approved.append(label);
    choices.push({ name, input });
  }
  tools.append(approved);
  button(tools, '保存批准范围', () => change('approval', { revision:connection.revision,
    tools:choices.filter(entry => entry.input.checked).map(entry => entry.name) }, '已保存批准范围'));
}

async function refresh(preferred) {
  rows = (await request('state')).connections;
  const chosen = preferred || picker.value;
  picker.replaceChildren();
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = row.id;
    picker.append(option);
  }
  picker.value = rows.some(row => row.id === chosen) ? chosen : rows[0]?.id ?? '';
  field('register').hidden = field('connections').hidden = false;
  if (!busy) renderDetail();
}

picker.addEventListener('change', () => { authorization.hidden = true; status.textContent = ''; renderDetail(); });
field('definition-form').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    let value;
    try { value = JSON.parse(definition.value); }
    catch { throw new Error('连接定义需为 JSON 对象。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('连接定义需为 JSON 对象。');
    const saved = await request('connections', 'POST', value);
    definition.value = '';
    await refresh(saved.id);
    status.textContent = '已保存连接定义';
  }, '正在保存连接定义');
});

async function open() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    token = (await request('session', 'POST', {ticket})).token;
    sessionStorage.setItem(key, token);
  } else token = sessionStorage.getItem(key);
  if (!token) throw new Error('请从 Kada 的 mcp connections 命令打开连接设置。');
  await refresh();
}
open().catch(error => { status.classList.add('error'); status.textContent = error.message; });
</script>
</body>
</html>`;
