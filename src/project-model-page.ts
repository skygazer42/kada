export const projectModelPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>项目模型 · Kada</title>
  <style>
    :root { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; color: #162426; background: #f6f7f3; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: clamp(16px, 5vw, 44px); }
    main { max-width: 720px; margin: auto; }
    h1 { margin: 0 0 8px; font-size: clamp(1.45rem, 4vw, 2rem); }
    #project { color: #4f625b; overflow-wrap: anywhere; margin: 0 0 22px; }
    section { background: #fff; border: 1px solid #dce3da; padding: clamp(14px, 4vw, 22px); border-radius: 10px; }
    #selected { margin: 0 0 16px; overflow-wrap: anywhere; }
    label { display: block; margin-bottom: 6px; font-weight: 650; }
    select, button { font: inherit; }
    select { display: block; width: 100%; color: inherit; background: #fff; border: 1px solid #a9bcb4; border-radius: 6px; padding: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    button { color: #21443c; background: #fff; border: 1px solid #bacbc2; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
    button.primary { background: #146857; border-color: #146857; color: white; font-weight: 650; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, select:focus-visible { outline: 2px solid #146857; outline-offset: 3px; }
    #status { min-height: 1.35em; color: #3e5951; }
    #status.error { color: #a32b28; }
  </style>
</head>
<body>
<main>
  <h1>项目模型</h1>
  <p id="project"></p>
  <section id="settings" aria-label="模型设置" hidden>
    <p id="selected"></p>
    <label for="model">模型</label>
    <select id="model"></select>
    <div class="actions">
      <button type="button" id="check">检查连接</button>
      <button type="button" id="save" class="primary">保存项目模型</button>
      <button type="button" id="reset">恢复全局模型</button>
    </div>
  </section>
  <p id="status" role="status" aria-live="polite"></p>
</main>
<script nonce="__MODEL_NONCE__">
const field = id => document.getElementById(id);
const model = field('model'), check = field('check'), save = field('save'), reset = field('reset'), status = field('status');
const sessionKey = 'kada-project-model-session';
let token, settings, catalog = [], busy = false;

const label = ref => ref ? ref.provider + ' / ' + ref.modelId : '未设置';
const chosen = () => model.value === '' ? undefined : catalog[Number(model.value)];
const refOf = item => ({ provider: item.provider, modelId: item.id });

async function request(path, method = 'GET', value) {
  const response = await fetch('/project-model/' + path, { method, headers: {
    ...(token ? {Authorization: 'Bearer ' + token} : {}), ...(value ? {'Content-Type': 'application/json'} : {}),
  }, ...(value ? {body: JSON.stringify(value)} : {}) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) sessionStorage.removeItem(sessionKey);
    throw new Error(result.error || '设置请求失败');
  }
  return result;
}

function controls() {
  const item = chosen();
  model.disabled = busy || !catalog.length;
  check.disabled = busy || !item;
  save.disabled = busy || !item || item.check?.status !== 'available';
  reset.disabled = busy || !settings?.override;
}

async function refresh(preferred) {
  settings = await request('state');
  field('project').textContent = settings.project;
  field('selected').textContent = (settings.override ? '当前项目模型 ' : '继承全局模型 ') + label(settings.selected);
  model.replaceChildren();
  catalog = settings.providers.flatMap(provider => provider.models.map(item => ({ ...item, provider: provider.id, configured: provider.authentication.configured })));
  for (const [index, item] of catalog.entries()) {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = label(refOf(item)) + (item.configured ? '' : ' · 未配置凭据');
    model.append(option);
  }
  const selected = preferred || settings.selected;
  const index = catalog.findIndex(item => selected && item.provider === selected.provider && item.id === selected.modelId);
  model.value = catalog.length ? String(index < 0 ? 0 : index) : '';
  field('settings').hidden = false;
  controls();
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

model.addEventListener('change', () => {
  status.classList.remove('error');
  const previous = chosen()?.check;
  status.textContent = previous?.message || (previous?.status === 'available' ? '连接检查通过' : '');
  controls();
});
check.addEventListener('click', () => void perform(async () => {
  const selected = refOf(chosen());
  const checked = await request('check', 'POST', selected);
  await refresh(selected);
  if (checked.status !== 'available') throw new Error(checked.message || '连接检查失败');
  status.textContent = '连接检查通过';
}, '正在检查连接'));
save.addEventListener('click', () => void perform(async () => {
  const selected = refOf(chosen());
  await request('model', 'POST', selected);
  await refresh(selected);
  status.textContent = '已保存项目模型';
}, '正在保存'));
reset.addEventListener('click', () => void perform(async () => {
  await request('model', 'DELETE');
  await refresh();
  status.textContent = '已恢复全局模型';
}, '正在恢复'));

async function open() {
  const ticket = location.hash.slice(1);
  if (ticket) {
    history.replaceState(null, '', location.pathname);
    token = (await request('session', 'POST', {ticket})).token;
    sessionStorage.setItem(sessionKey, token);
  } else token = sessionStorage.getItem(sessionKey);
  if (!token) throw new Error('请从 Kada 的 model browser 命令打开项目设置。');
  await refresh();
}
open().catch(error => { status.classList.add('error'); status.textContent = error.message; });
</script>
</body>
</html>`;
