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
    label { display:flex; align-items:baseline; gap:6px; overflow-wrap:anywhere; }
    fieldset { margin:14px 0 10px; border:1px solid #dce3da; border-radius:6px; min-inline-size:0; }
    fieldset label { margin:7px 0; }
    legend { font-weight:650; overflow-wrap:anywhere; }
    button { padding:8px 12px; margin-top:12px; font:inherit; font-weight:650; border:1px solid #146857; border-radius:6px; background:#146857; color:#fff; cursor:pointer; }
    button:disabled { opacity:.55; cursor:default; }
    button:focus-visible, input:focus-visible { outline:2px solid #146857; outline-offset:3px; }
    #status { min-height:1.35em; color:#3d5d51; }
    #status.error { color:#a32b28; }
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
    throw new Error(result.error || '工具范围请求失败');
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
}
open().catch(error => { status.classList.add('error'); status.textContent = error.message; });
</script>
</body>
</html>`;
