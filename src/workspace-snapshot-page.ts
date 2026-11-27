export const workspaceSnapshotPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>工作区快照 · Kada</title>
  <style>
    :root { font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif; color:#172727; background:#f6f7f3; }
    * { box-sizing:border-box; }
    body { margin:0; padding:clamp(16px,5vw,44px); }
    main { max-width:760px; margin:auto; }
    h1 { margin:0 0 8px; font-size:clamp(1.45rem,4vw,2rem); }
    #workspace { color:#4f625b; overflow-wrap:anywhere; margin:0 0 22px; }
    section { padding:clamp(14px,4vw,22px); background:#fff; border:1px solid #dce3da; border-radius:10px; margin:0 0 12px; }
    form > label { display:block; margin-bottom:6px; font-weight:650; }
    input { width:100%; font:inherit; padding:8px; border:1px solid #a9bcb4; border-radius:6px; }
    button { padding:7px 11px; font:inherit; border:1px solid #bacbc2; border-radius:6px; background:#fff; color:#175749; cursor:pointer; }
    form button, #restore { margin-top:8px; }
    button.primary { background:#146857; border-color:#146857; color:white; font-weight:650; }
    button:disabled { opacity:.55; cursor:default; }
    button:focus-visible, input:focus-visible { outline:2px solid #146857; outline-offset:3px; }
    h2 { margin:15px 0 6px; font-size:1.05rem; }
    ul { margin:4px 0 0; padding:0; list-style:none; }
    li { border-top:1px solid #e2e9e3; padding:9px 0; overflow-wrap:anywhere; }
    #snapshots li { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:7px; }
    .metadata { display:block; color:#4f625b; font-size:.875rem; }
    #status { min-height:1.35em; color:#3e5951; }
    #status.error { color:#a32b28; }
  </style>
</head>
<body>
<main>
  <h1>工作区快照</h1>
  <p id="workspace"></p>
  <section id="settings" aria-label="工作区快照管理" hidden>
    <form id="create">
      <label for="label">快照名称</label>
      <input id="label" required>
      <button id="save" class="primary" type="submit">保存快照</button>
    </form>
    <h2>已有快照</h2>
    <ul id="snapshots"></ul>
  </section>
  <section id="preview" aria-label="恢复预览" hidden>
    <h2 id="preview-title">恢复预览</h2>
    <ul id="changes"></ul>
    <button class="primary" id="restore" type="button">确认恢复</button>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="__SNAPSHOT_NONCE__">
const field = id => document.getElementById(id);
const label = field('label'), list = field('snapshots'), changes = field('changes'), status = field('status');
const key = 'kada-workspace-snapshot-session';
let token, preview, busy = false;

async function request(path, method = 'GET', input) {
  const response = await fetch('/workspace-snapshots/' + path, { method, headers: {
    ...(token ? { Authorization:'Bearer ' + token } : {}), ...(input ? {'Content-Type':'application/json'} : {}),
  }, ...(input ? {body:JSON.stringify(input)} : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(key);
    throw new Error(result.error || '快照请求失败');
  }
  return result;
}

function controls() {
  label.disabled = field('save').disabled = busy;
  for (const button of list.querySelectorAll('button')) button.disabled = busy;
  field('restore').disabled = busy || !preview?.changes.length;
}

async function perform(action, progress) {
  if (busy) return;
  busy = true;
  status.classList.remove('error');
  status.textContent = progress;
  controls();
  try { await action(); }
  catch (error) { status.classList.add('error'); status.textContent = error.message; }
  finally { busy = false; controls(); }
}

function showPreview(data) {
  preview = data;
  field('preview-title').textContent = '恢复预览 · ' + data.snapshot.label;
  changes.replaceChildren();
  const names = { restore:'恢复', replace:'替换', remove:'移除' };
  for (const change of data.changes) {
    const row = document.createElement('li');
    row.textContent = names[change.action] + ' ' + change.path;
    changes.append(row);
  }
  if (!data.changes.length) changes.textContent = '当前工作区与该快照相同。';
  field('preview').hidden = false;
  controls();
}

async function refresh() {
  const state = await request('state');
  field('workspace').textContent = state.workspace;
  list.replaceChildren();
  for (const item of state.snapshots) {
    const row = document.createElement('li'), info = document.createElement('div');
    const name = document.createElement('strong'), date = document.createElement('span');
    name.textContent = item.label;
    date.className = 'metadata';
    date.textContent = new Date(item.createdAt).toLocaleString() + ' · ' + item.files + ' 个文件';
    info.append(name, date);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '预览恢复';
    button.setAttribute('aria-label', '预览恢复 ' + item.label);
    button.addEventListener('click', () => void perform(async () => {
      showPreview(await request('snapshots/' + encodeURIComponent(item.id) + '/preview'));
      status.textContent = '';
    }, '正在比较工作区'));
    row.append(info, button);
    list.append(row);
  }
  if (!state.snapshots.length) list.textContent = '当前工作区还没有快照。';
  field('settings').hidden = false;
  controls();
}

field('create').addEventListener('submit', event => {
  event.preventDefault();
  void perform(async () => {
    await request('snapshots', 'POST', {label: label.value});
    label.value = '';
    await refresh();
    status.textContent = '已保存快照';
  }, '正在保存');
});
field('restore').addEventListener('click', () => void perform(async () => {
  const chosen = preview;
  if (!chosen || !chosen.changes.length) return;
  field('preview').hidden = true;
  preview = undefined;
  const result = await request('snapshots/' + encodeURIComponent(chosen.snapshot.id) + '/restore', 'POST', {version: chosen.version});
  await refresh();
  status.textContent = result.undoSnapshotId ? '已恢复。恢复前的版本已另存为快照。' : '工作区已处于该快照版本。';
}, '正在恢复工作区'));

async function open() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    token = (await request('session', 'POST', {ticket})).token;
    sessionStorage.setItem(key, token);
  } else token = sessionStorage.getItem(key);
  if (!token) throw new Error('请从 Kada 的 snapshots browser 命令打开原工作区。');
  await refresh();
}
open().catch(error => { status.classList.add('error'); status.textContent = error.message; });
</script>
</body>
</html>`;
