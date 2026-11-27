export const projectAssistantsPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>项目助手 · Kada</title>
  <style>
    :root { color:#172727; background:#f6f7f3; font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; padding:clamp(16px,5vw,44px); }
    main { max-width:760px; margin:auto; }
    h1 { margin:0; font-size:clamp(1.45rem,4vw,2rem); }
    #project,#status { color:#3e5951; overflow-wrap:anywhere; }
    section { background:#fff; border:1px solid #dce3da; border-radius:10px; padding:clamp(14px,4vw,22px); }
    label { display:block; font-weight:650; }
    input:not([type=checkbox]), select, textarea, button { font:inherit; color:inherit; }
    input:not([type=checkbox]),select,textarea { display:block; width:100%; margin:5px 0 12px; padding:8px; border:1px solid #a9bcb4; border-radius:6px; background:#fff; }
    textarea { min-height:4rem; resize:vertical; }
    #instructions { min-height:8rem; }
    fieldset { margin:0; padding:0; border:0; min-inline-size:0; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 12px; }
    button { border:1px solid #bacbc2; border-radius:6px; background:#fff; color:#175749; padding:7px 11px; cursor:pointer; }
    button.primary { color:white; background:#146857; border-color:#146857; font-weight:650; }
    button:disabled { opacity:.55; cursor:default; }
    :focus-visible { outline:2px solid #146857; outline-offset:3px; }
    #status.error { color:#a32b28; }
  </style>
</head>
<body>
<main>
  <h1>项目助手</h1>
  <p id="project"></p>
  <section id="settings" hidden>
    <label for="roles">助手</label>
    <select id="roles"></select>
    <button id="refresh" type="button">重新读取</button>
    <form id="editor">
      <fieldset id="fields">
        <label for="name">名称</label><input id="name" required maxlength="80">
        <label for="description">说明</label><textarea id="description" maxlength="1000"></textarea>
        <label for="instructions">指令</label><textarea id="instructions" required maxlength="16000"></textarea>
        <label for="model">模型</label><select id="model"></select>
        <label for="tools">允许的工具（每行一个）</label><textarea id="tools" spellcheck="false"></textarea>
        <label id="archive" hidden><input id="archived" type="checkbox"> 归档此助手</label>
        <div class="actions"><button id="save" class="primary" type="submit">保存助手</button></div>
      </fieldset>
    </form>
    <div id="launch" hidden>
      <label id="command-label" for="command">在 Kada 目录运行以开始新会话</label>
      <input id="command" readonly>
      <button id="copy" type="button">复制命令</button>
    </div>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="__ASSISTANTS_NONCE__">
const field = id => document.getElementById(id);
const roles = field('roles'), models = field('model'), status = field('status');
const key = 'kada-project-assistants-session';
let token, current, catalog = [], pending, workspaceArgument;
function option(select, value, label) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = label;
  select.append(item);
}
function report(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}
async function request(path, method = 'GET', body) {
  const response = await fetch('/project-assistants/' + path, {
    method, headers: { ...(token ? { Authorization:'Bearer ' + token } : {}), ...(body ? { 'Content-Type':'application/json' } : {}) },
    ...(body ? { body:JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (response.status === 401) sessionStorage.removeItem(key);
  if (!response.ok) throw new Error(result.error);
  return result;
}
async function perform(work) {
  const controls = [roles, field('refresh'), field('fields'), field('copy')];
  controls.forEach(element => { element.disabled = true; });
  report('');
  try { await work(); }
  catch (error) { report(error.message, true); }
  finally { controls.forEach(element => { element.disabled = false; }); }
}
function render(role) {
  current = role;
  pending = undefined;
  for (const id of ['name','description','instructions']) field(id).value = role?.[id] ?? '';
  field('tools').value = role?.tools.join('\n') ?? '';
  field('archive').hidden = !role;
  field('archived').checked = role?.archived ?? false;
  field('launch').hidden = !role || role.archived;
  field('command').value = role ? 'npm run harness -- chat --assistant ' + role.id + '@' + role.revision + ' --workspace ' + workspaceArgument : '';
  const selected = role?.model ? JSON.stringify(role.model) : '';
  models.replaceChildren();
  option(models, '', '使用项目默认模型');
  for (const { provider, modelId, name } of catalog) option(models, JSON.stringify({ provider, modelId }), name + ' · ' + provider);
  if (selected && !Array.from(models.options).some(item => item.value === selected)) option(models, selected, role.model.modelId + ' · 当前目录不可用');
  models.value = selected;
}
async function refresh(preferred, saved) {
  const state = await request('state');
  const chosen = preferred ?? state.roles[0]?.id ?? '';
  const role = chosen ? saved ?? await request('roles/' + encodeURIComponent(chosen)) : undefined;
  field('project').textContent = state.project;
  workspaceArgument = "'" + state.project.replaceAll("'", state.windows ? "''" : "'\\''") + "'";
  field('command-label').textContent = state.windows ? '在 Kada 目录的 PowerShell 中运行' : '在 Kada 目录运行以开始新会话';
  catalog = state.models;
  roles.replaceChildren();
  option(roles, '', '新建助手');
  for (const row of state.roles) option(roles, row.id, row.name + (row.archived ? '（已归档）' : ''));
  roles.value = chosen;
  render(role);
  field('settings').hidden = false;
}
roles.addEventListener('change', () => void perform(async () => {
  const selected = roles.value;
  try { render(selected ? await request('roles/' + encodeURIComponent(selected)) : undefined); }
  catch (error) { roles.value = current?.id ?? ''; throw error; }
}));
field('refresh').addEventListener('click', () => void perform(async () => {
  await refresh(roles.value);
  report('已读取项目助手。');
}));
field('editor').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    const path = current ? 'roles/' + encodeURIComponent(current.id) : 'roles';
    const method = current ? 'PATCH' : 'POST';
    const model = models.value ? JSON.parse(models.value) : null;
    const body = {
      name:field('name').value, description:field('description').value, instructions:field('instructions').value,
      tools:field('tools').value.split(/\r?\n/).map(name => name.trim()).filter(Boolean),
      ...(!current || JSON.stringify(model) !== JSON.stringify(current.model) ? { model } : {}),
      ...(current ? { revision:current.revision, archived:field('archived').checked } : {}),
    };
    const signature = JSON.stringify([path, body]);
    if (pending?.signature !== signature) pending = { signature, id:crypto.randomUUID() };
    const saved = await request(path, method, { ...body, requestId:pending.id });
    await refresh(saved.id, saved);
    report('已保存助手，修订 ' + saved.revision + '。');
  });
});
field('copy').addEventListener('click', () => void perform(async () => {
  await navigator.clipboard.writeText(field('command').value);
  report('已复制命令。');
}));
async function open() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    token = (await request('session', 'POST', { ticket })).token;
    sessionStorage.setItem(key, token);
  } else token = sessionStorage.getItem(key);
  if (!token) throw new Error('请从 Kada 的 assistants browser 命令打开项目设置。');
  await refresh();
}
open().catch(error => report(error.message, true));
</script>
</body>
</html>`;
