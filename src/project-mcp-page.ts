export const projectMcpPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>项目 MCP 工具 · Kada</title>
  <style>
    :root { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; color:#172727; background:#f6f7f3; }
    * { box-sizing:border-box; }
    body { margin:0; padding:clamp(16px,5vw,44px); }
    main { max-width:720px; margin:auto; }
    h1 { margin:0 0 8px; font-size:clamp(1.45rem,4vw,2rem); }
    #project { color:#4f625b; overflow-wrap:anywhere; margin:0 0 22px; }
    section { padding:clamp(14px,4vw,22px); background:#fff; border:1px solid #dce3da; border-radius:10px; }
    section + section { margin-top:16px; }
    label { display:flex; align-items:baseline; gap:6px; overflow-wrap:anywhere; }
    fieldset { margin:14px 0 10px; border:1px solid #dce3da; border-radius:6px; min-inline-size:0; }
    fieldset label { margin:7px 0; }
    legend { font-weight:650; overflow-wrap:anywhere; }
    button { padding:8px 12px; margin-top:12px; font:inherit; font-weight:650; border:1px solid #146857; border-radius:6px; background:#146857; color:#fff; cursor:pointer; }
    button:disabled { opacity:.55; cursor:default; }
    button:focus-visible, input:focus-visible { outline:2px solid #146857; outline-offset:3px; }
    #status { min-height:1.35em; color:#3d5d51; }
    #status.error { color:#a32b28; }
    h2 { margin:0 0 10px; font-size:1.22rem; }
    details { padding:10px 0; border-top:1px solid #dce3da; }
    summary { cursor:pointer; overflow-wrap:anywhere; }
    .binding-label { display:grid; margin:10px 0; }
    .binding-label input, .binding-label select { min-width:0; width:100%; padding:8px; font:inherit; border:1px solid #a5b5ab; border-radius:6px; }
    .binding-action { display:flex; gap:10px; flex-wrap:wrap; }
    .secondary { background:#fff; color:#146857; }
    .binding-status { margin:8px 0 0; color:#3d5d51; }
    .binding-status.error { color:#a32b28; }
  </style>
</head>
<body>
<main>
  <h1>项目 MCP 工具</h1>
  <p id="project"></p>
  <section id="settings" aria-label="项目工具范围" hidden>
    <p id="scope"></p>
    <label><input type="checkbox" id="inherit">继承已启用工具</label>
    <div id="connections"></div>
    <button id="save" type="button">保存工具范围</button>
  </section>
  <section id="app-bindings" aria-labelledby="app-bindings-title" hidden>
    <h2 id="app-bindings-title">应用连接</h2>
    <p id="bindings-status" class="binding-status error" role="status" hidden></p>
    <details>
      <summary>Gmail <span id="gmail-bound"></span></summary>
      <form id="gmail-binding">
        <label class="binding-label">Gmail MCP 连接<select name="connection" required></select></label>
        <label class="binding-label">邮箱地址<input name="email" type="email" maxlength="320" required></label>
        <label><input name="allowAssistant" type="checkbox">允许助手访问 Gmail</label>
        <div class="binding-action">
          <button type="submit">保存 Gmail</button>
          <button type="button" class="secondary" name="clear">解除 Gmail 绑定</button>
        </div>
        <p class="binding-status" role="status"></p>
      </form>
    </details>
    <details>
      <summary>Google 日历 <span id="calendar-bound"></span></summary>
      <form id="calendar-binding">
        <label class="binding-label">日历 MCP 连接<select name="connection" required></select></label>
        <label class="binding-label">账号别名<input name="account" maxlength="64" required></label>
        <label class="binding-label">日历 ID<input name="calendarId" placeholder="primary" maxlength="512" required></label>
        <label class="binding-label">IANA 时区<input name="timeZone" placeholder="Asia/Shanghai" maxlength="128" required></label>
        <label><input name="allowAssistant" type="checkbox">允许助手访问 Google 日历</label>
        <div class="binding-action">
          <button type="submit">保存 Google 日历</button>
          <button type="button" class="secondary" name="clear">解除日历绑定</button>
        </div>
        <p class="binding-status" role="status"></p>
      </form>
    </details>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="__MCP_NONCE__">
const field = id => document.getElementById(id);
const inherit = field('inherit'), connections = field('connections'), save = field('save'), status = field('status');
const key = 'kada-project-mcp-session';
let token, entries = [], busy = false;

async function request(path, method = 'GET', input) {
  const response = await fetch('/project-mcp/' + path, { method, headers: {
    ...(token ? {Authorization:'Bearer ' + token} : {}), ...(input ? {'Content-Type':'application/json'} : {}),
  }, ...(input ? {body:JSON.stringify(input)} : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(key);
    throw new Error(result.error || '项目设置请求失败');
  }
  return result;
}

function controls() {
  inherit.disabled = busy;
  save.disabled = busy;
  for (const group of connections.querySelectorAll('fieldset')) group.disabled = busy || inherit.checked;
}

async function refresh() {
  const state = await request('state');
  field('project').textContent = state.project;
  field('scope').textContent = state.tools === null ? '当前范围 继承已启用工具' : '当前范围 项目允许 ' + state.tools.length + ' 项';
  inherit.checked = state.tools === null;
  const selected = new Set((state.tools ?? []).map(item => JSON.stringify([item.id, item.tool])));
  connections.replaceChildren();
  entries = [];
  for (const connection of state.connections) {
    const group = document.createElement('fieldset'), title = document.createElement('legend');
    title.textContent = connection.id;
    group.append(title);
    for (const tool of connection.tools) {
      const row = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state.tools === null || selected.has(JSON.stringify([connection.id, tool]));
      row.append(input, tool);
      group.append(row);
      entries.push({ id: connection.id, tool, input });
    }
    connections.append(group);
  }
  if (!entries.length) connections.textContent = '当前没有已启用的 MCP 工具。';
  field('settings').hidden = false;
  controls();
}

function bindingEditor(kind, fields, display) {
  const form = field(kind + '-binding'), connection = form.elements.connection;
  const clear = form.elements.clear, submit = form.querySelector('[type=submit]');
  const status = form.querySelector('.binding-status'), current = field(kind + '-bound');
  const identity = item => item ? JSON.stringify([item.id,item.revision]) : '';
  let source = null, candidates = [], pending = false, initialized = false, version = 0;

  function controls() {
    const eligible = candidates.some(item => identity(item) === connection.value);
    connection.disabled = pending || !candidates.length;
    for (const name of fields) form.elements[name].disabled = pending;
    form.elements.allowAssistant.disabled = pending;
    submit.disabled = pending || !eligible;
    clear.disabled = pending || !source;
  }

  function render(next, resetFields) {
    const selected = resetFields || !initialized ? identity(next.source) : connection.value;
    candidates = next.connections;
    source = next.source;
    connection.replaceChildren(new Option(candidates.length ? '选择已启用的连接' : '无可用的只读连接',''));
    for (const item of candidates) connection.add(new Option(item.id,identity(item)));
    if (selected && !candidates.some(item => identity(item) === selected)) {
      const previous = new Option(JSON.parse(selected)[0] + '（权限或修订已变更）',selected);
      previous.disabled = true;
      connection.add(previous);
    }
    connection.value = selected;
    if (resetFields || !initialized) {
      for (const name of fields) form.elements[name].value = source?.[name] ?? '';
      form.elements.allowAssistant.checked = source?.allowAssistant === true;
    }
    current.textContent = source ? '· ' + display(source) : '· 未绑定';
    initialized = true;
    controls();
  }

  async function saveBinding(method) {
    if (pending) return;
    const item = candidates.find(candidate => identity(candidate) === connection.value);
    if (method === 'PUT' && !item) return;
    const body = method === 'PUT' ? { ...item, allowAssistant:form.elements.allowAssistant.checked } : undefined;
    if (body) for (const name of fields) body[name] = form.elements[name].value.trim();
    pending = true;
    version++;
    status.textContent = '正在保存';
    status.classList.remove('error');
    controls();
    try {
      const saved = await request(kind + '-source',method,body);
      render({source:saved.source,connections:candidates},true);
      status.textContent = method === 'PUT' ? '已保存绑定' : '已解除绑定';
    } catch (error) {
      status.classList.add('error');
      status.textContent = error.message;
    } finally {
      pending = false;
      version++;
      controls();
    }
  }

  connection.addEventListener('change',controls);
  form.addEventListener('submit',event => { event.preventDefault(); void saveBinding('PUT'); });
  clear.addEventListener('click',() => void saveBinding('DELETE'));
  controls();
  return {
    version:() => version,
    refresh:(next,initial,observedVersion) => render(observedVersion === version ? next : {...next,source},initial),
  };
}

const gmail = bindingEditor('gmail',['email'],source => source.email);
const calendar = bindingEditor('calendar',['account','calendarId','timeZone'],source => source.account + ' / ' + source.calendarId);

async function refreshBindings(initial = false) {
  const versions = [gmail.version(),calendar.version()];
  const status = field('bindings-status');
  try {
    const apps = await request('bindings');
    gmail.refresh(apps.gmail,initial,versions[0]);
    calendar.refresh(apps.calendar,initial,versions[1]);
    field('app-bindings').hidden = false;
    status.hidden = true;
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
    field('app-bindings').hidden = false;
  }
}

inherit.addEventListener('change', controls);
save.addEventListener('click', async () => {
  if (busy) return;
  const tools = inherit.checked ? null : entries.filter(item => item.input.checked).map(({id, tool}) => ({id, tool}));
  busy = true;
  status.textContent = '正在保存';
  status.classList.remove('error');
  controls();
  try {
    await request('tools', 'PUT', {tools});
    await refresh();
    await refreshBindings();
    status.textContent = '已保存项目工具范围';
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally { busy = false; controls(); }
});

async function open() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    token = (await request('session', 'POST', {ticket})).token;
    sessionStorage.setItem(key, token);
  } else token = sessionStorage.getItem(key);
  if (!token) throw new Error('请从 Kada 的 mcp browser 命令打开项目设置。');
  await refresh();
  await refreshBindings(true);
}
open().catch(error => { status.classList.add('error'); status.textContent = error.message; });
</script>
</body>
</html>`;
