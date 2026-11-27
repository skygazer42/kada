export const workboardPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kada 工作看板</title>
  <style>
    :root { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; color: #162426; background: #f6f7f3; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #146857; outline-offset: 2px; }
    button:disabled { opacity: .45; cursor: default; }
    header { padding: 26px clamp(16px, 4vw, 48px) 19px; border-bottom: 1px solid #dce3da; background: #fcfcfa; display: flex; gap: 18px; align-items: end; justify-content: space-between; }
    h1 { margin: 0 0 6px; font-size: clamp(1.65rem, 3vw, 2.05rem); letter-spacing: -.035em; }
    #project { margin: 0; color: #52615b; overflow-wrap: anywhere; font-size: .875rem; }
    #toolbar, .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    #toolbar[hidden] { display: none; }
    .action { min-height: 38px; padding: 7px 13px; border: 1px solid #c9d4ca; color: #233732; background: #fff; border-radius: 7px; white-space: nowrap; }
    .primary { color: #fff; background: #145d4b; border-color: #145d4b; font-weight: 600; }
    .quiet { border-color: transparent; background: transparent; padding: 5px 8px; }
    .action:hover:not(:disabled) { filter: brightness(.95); }
    #status { margin: 13px clamp(16px, 4vw, 48px) 0; min-height: 1.35em; color: #52615b; font-size: .875rem; }
    #status.error { color: #a32b28; }
    #board { display: flex; align-items: flex-start; gap: 14px; overflow-x: auto; padding: 12px clamp(16px, 4vw, 48px) 26px; }
    #board.deadlines { display: block; max-width: 960px; }
    #deadline-controls { margin: 10px clamp(16px, 4vw, 48px) 0; align-items: center; }
    #deadline-controls[hidden] { display: none; }
    #deadline-controls h2 { min-width: 7em; }
    #deadlines[aria-pressed="true"] { border-color: #146857; color: #145d4b; background: #eaf0e9; }
    .day { margin: 0 0 18px; }
    .day h2 { margin: 0 0 8px; }
    .day .cards { min-height: 0; padding: 0; }
    .column { min-width: min(290px, 84vw); max-width: 340px; flex: 1 0 290px; border-radius: 11px; background: #eaf0e9; border: 1px solid #dce4da; }
    .column.over { border-color: #146857; background: #dbeadf; }
    .column-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 8px; }
    h2 { font-size: 1.03rem; margin: 0; overflow-wrap: anywhere; }
    .count { color: #52615b; font-size: .84rem; font-weight: 500; margin-left: 8px; }
    .cards { margin: 0; list-style: none; padding: 0 10px 12px; min-height: 74px; display: grid; gap: 8px; }
    .card { display: grid; gap: 8px; text-align: left; width: 100%; padding: 13px; border-radius: 8px; border: 1px solid #dce3da; color: #162426; background: #fff; }
    .card:hover { border-color: #89a494; }
    .card-title { font-weight: 650; overflow-wrap: anywhere; }
    .meta { color: #53615b; font-size: .82rem; overflow-wrap: anywhere; }
    .empty { color: #52615b; padding: 10px; font-size: .85rem; }
    dialog { border: 1px solid #ced7ce; border-radius: 13px; padding: 22px; width: min(540px, calc(100vw - 28px)); color: #162426; background: #fff; }
    dialog::backdrop { background: #13292370; }
    .dialog-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
    .dialog-head h2 { font-size: 1.18rem; }
    form { display: grid; gap: 11px; margin: 0; }
    label { display: grid; gap: 5px; font-size: .88rem; font-weight: 550; }
    input, select, textarea { min-width: 0; width: 100%; padding: 8px 9px; border: 1px solid #bccac0; border-radius: 6px; color: #162426; background: #fff; }
    textarea { min-height: 100px; resize: vertical; }
    .edit-block { border-top: 1px solid #dde4db; padding-top: 12px; margin-top: 15px; }
    .sharing summary { cursor: pointer; font-weight: 600; }
    .sharing label.permission { display: flex; align-items: center; gap: 8px; }
    .sharing input[type="checkbox"] { width: auto; }
    .sharing-accounts { padding: 0; list-style: none; }
    .sharing-accounts li + li { margin-top: 8px; }
    .dialog-error { color: #a32b28; min-height: 1.1em; font-size: .86rem; margin: 7px 0 0; }
    @media (max-width: 620px) { header { display: grid; align-items: start; } .column { flex-basis: min(290px, 84vw); } }
  </style>
</head>
<body>
  <header>
    <div><h1>工作看板</h1><p id="project"></p></div>
    <div id="toolbar" hidden>
      <button id="add-item" class="action primary" type="button">新建工作项</button>
      <button id="add-column" class="action" type="button">添加列</button>
      <button id="deadlines" class="action" type="button" aria-pressed="false" aria-controls="board">截止日历</button>
      <button id="refresh" class="action" type="button">刷新</button>
    </div>
  </header>
  <p id="status" role="status" aria-live="polite">正在打开看板</p>
  <div id="deadline-controls" class="actions" hidden>
    <h2 id="deadline-month" aria-live="polite"></h2>
    <button id="deadline-prev" class="action" type="button">上个月</button>
    <button id="deadline-today" class="action" type="button">本月</button>
    <button id="deadline-next" class="action" type="button">下个月</button>
  </div>
  <p id="calendar-status" role="status" aria-live="polite" hidden></p>
  <main id="board" aria-label="项目工作项"></main>
  <dialog id="editor" aria-labelledby="editor-title">
    <div class="dialog-head"><h2 id="editor-title"></h2><button id="close-editor" class="action quiet" type="button">关闭</button></div>
    <div id="editor-content"></div>
    <p class="dialog-error" id="editor-error" role="alert"></p>
  </dialog>
  <script nonce="__BOARD_NONCE__">
  const get = id => document.getElementById(id);
  const panel = get('board'), editor = get('editor'), fields = get('editor-content');
  const accessKey = 'kada-workboard-session';
  const priorities = [['low','低'], ['normal','普通'], ['high','高'], ['urgent','紧急']];
  const statuses = [['open','待办'], ['parked','搁置'], ['done','已完成']];
  let token, board, busy = false, dragged;
  let viewingDeadlines = false, agendaMonth = new Date();
  let externalCalendar, calendarRead;
  function element(parent, tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }
  function button(parent, text, onClick, style) {
    const node = element(parent, 'button', text, 'action' + (style ? ' ' + style : ''));
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
  }
  function setStatus(text, error = false) {
    get('status').textContent = text;
    get('status').classList.toggle('error', error);
  }
  async function request(path, method = 'GET', data, signal) {
    const response = await fetch('/workboard/' + path, { method, headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401) sessionStorage.removeItem(accessKey);
      const error = new Error(value.error || '请求失败'); error.status = response.status; throw error;
    }
    return value;
  }
  async function refresh() {
    board = await request('board');
    get('project').textContent = board.project;
    get('toolbar').hidden = false;
    render();
  }
  async function save(action, result, closeDialog = true) {
    if (busy) return;
    busy = true;
    setStatus('正在保存');
    get('editor-error').textContent = '';
    try {
      await action();
      await refresh();
      if (closeDialog && editor.open) editor.close();
      setStatus(result);
    } catch (error) {
      setStatus(error.message, true);
      if (editor.open) get('editor-error').textContent = error.message;
      else if (error.status === 409) { try { await refresh(); } catch {} }
    } finally { busy = false; }
  }
  function command(action, version = board.version) {
    return request('board', 'PATCH', { ...action, version, requestId: crypto.randomUUID() });
  }
  function selectField(parent, title, options, selected) {
    const select = element(element(parent, 'label', title), 'select');
    for (const [value, text] of options) element(select, 'option', text).value = value;
    select.value = selected;
    return select;
  }
  function field(parent, title, value, max, tag = 'input', required = true) {
    const node = element(element(parent, 'label', title), tag);
    node.value = value; node.maxLength = max; node.required = required;
    return node;
  }
  function formSubmit(form, text, submit) {
    const row = element(form, 'div', undefined, 'actions');
    const control = element(row, 'button', text, 'action primary');
    control.type = 'submit';
    form.addEventListener('submit', event => { event.preventDefault(); submit(); });
    return control;
  }
  function showEditor(title) {
    fields.replaceChildren();
    get('editor-title').textContent = title;
    get('editor-error').textContent = '';
    return fields;
  }
  function sharingEditor(host, item) {
    const section = element(host, 'details', undefined, 'edit-block sharing');
    element(section, 'summary', '账户共享');
    const list = element(section, 'ul', undefined, 'sharing-accounts');
    const form = element(section, 'form');
    const account = field(form, '配对账户 ID', '', 80);
    const role = selectField(form, '账户角色', [['viewer', '查看'], ['participant', '查看和答复']], 'viewer');
    const checkbox = title => {
      const toggle = element(element(form, 'label', title, 'permission'), 'input');
      toggle.type = 'checkbox';
      return toggle;
    };
    const edits = checkbox('编辑工作项');
    const controls = checkbox('控制原运行');
    const status = element(section, 'p', undefined, 'meta');
    status.setAttribute('role', 'status');
    const path = 'items/' + item.id + '/accounts';
    const accountPath = id => path + '/' + encodeURIComponent(id);
    let pending = false;
    function selectGrant(grant) {
      account.value = grant.accountId;
      role.value = grant.role;
      edits.checked = grant.edits;
      controls.checked = grant.controls;
      account.focus();
    }
    async function load() {
      const grants = await request(path);
      list.replaceChildren();
      if (!grants.length) element(list, 'li', '暂无账户授权', 'meta');
      for (const grant of grants) {
        const row = element(list, 'li');
        const scopes = [grant.role === 'participant' ? '查看和答复' : '查看'];
        if (grant.edits) scopes.push('编辑');
        if (grant.controls) scopes.push('控制');
        element(row, 'div', grant.accountId + ' · ' + scopes.join('、'), 'meta');
        const actions = element(row, 'div', undefined, 'actions');
        button(actions, '编辑授权', () => selectGrant(grant), 'quiet').setAttribute('aria-label', '编辑授权 ' + grant.accountId);
        button(actions, '撤回授权', () => void change('DELETE', grant.accountId), 'quiet').setAttribute('aria-label', '撤回授权 ' + grant.accountId);
      }
    }
    async function run(message, action) {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.textContent = message;
      try {
        status.textContent = await action();
      } catch (error) { status.textContent = error.message; }
      finally { pending = false; submit.disabled = false; }
    }
    function change(method, id, value) {
      return run('正在更新授权', async () => {
        await request(accountPath(id), method, value);
        await load();
        return method === 'DELETE' ? '已撤回账户授权' : '已保存账户授权';
      });
    }
    const submit = formSubmit(form, '保存授权', () => void change('PUT', account.value.trim(), {
      role: role.value, edits: edits.checked, controls: controls.checked,
    }));
    section.addEventListener('toggle', () => {
      if (section.open) void run('正在读取授权', async () => { await load(); return ''; });
    });
  }
  function itemEditor(item, column) {
    const host = showEditor(item ? '工作项' : '新建工作项');
    const form = element(host, 'form'), version = board.version;
    const requestId = crypto.randomUUID();
    const title = field(form, '名称', item?.title || '', 120);
    const objective = field(form, '任务说明', item?.objective || '', 32000, 'textarea');
    const priority = selectField(form, '优先级', priorities, item?.priority || 'normal');
    const key = assistant => assistant.id + '@' + assistant.revision;
    const available = board.assistants || [];
    const current = item?.assignee;
    const candidates = current && !available.some(assistant => key(assistant) === key(current)) ? [current, ...available] : available;
    const assignment = selectField(form, '分配助手', [['', '未分配'], ...candidates.map(assistant =>
      [key(assistant), assistant.name + ' · 修订 ' + assistant.revision])], current ? key(current) : '');
    const date = field(form, '截止日期或时刻', item?.dueDate || item?.dueAt || '', 80, 'input', false);
    date.placeholder = 'YYYY-MM-DD 或带时区偏移的 ISO 时刻';
    const zone = field(form, '时区', item?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', 128);
    formSubmit(form, '保存工作项', () => {
      const deadline = date.value.trim(), day = /^\d{4}-\d{2}-\d{2}$/.test(deadline);
      const selected = candidates.find(assistant => key(assistant) === assignment.value);
      const details = { title: title.value, objective: objective.value, priority: priority.value,
        assignee: selected ? { id: selected.id, revision: selected.revision } : null,
        dueDate: day ? deadline : null, dueAt: deadline && !day ? deadline : null, timeZone: zone.value,
        requestId, ...(item ? { revision: item.revision } : {}) };
      void save(() => request(item ? 'items/' + item.id : 'items', item ? 'PATCH' : 'POST', details), '已保存工作项');
    });
    if (item) {
      const move = element(host, 'form', undefined, 'edit-block');
      const destination = selectField(move, '移动到列', board.columns.map(entry => [entry.id, entry.title]), column.id);
      const position = selectField(move, '放在此卡之前', [['', '列末']], '');
      const positions = () => {
        position.replaceChildren(new Option('列末', ''));
        for (const card of board.columns.find(entry => entry.id === destination.value).items) {
          if (card.id !== item.id) position.add(new Option(card.title, card.id));
        }
      };
      positions(); destination.addEventListener('change', positions);
      formSubmit(move, '移动工作项', () => void save(() => command({ action: 'move-card', itemId: item.id,
        itemRevision: item.revision, columnId: destination.value, beforeId: position.value || null }, version), '已移动工作项'));
      if (board.manageSharing) sharingEditor(host, item);
    }
    editor.showModal(); title.focus();
  }
  function columnEditor(column) {
    const host = showEditor(column ? '列选项' : '添加列');
    const form = element(host, 'form'), version = board.version;
    const name = field(form, '列名称', column?.title || '', 80);
    const state = column ? undefined : selectField(form, '卡片状态', statuses, 'open');
    formSubmit(form, column ? '保存列名称' : '创建列', () => {
      const action = column ? { action: 'rename-column', columnId: column.id, title: name.value }
        : { action: 'add-column', title: name.value, status: state.value };
      void save(() => command(action, version), '已保存列');
    });
    if (column) {
      const controls = element(host, 'div', undefined, 'actions edit-block');
      const ids = board.columns.map(entry => entry.id), at = ids.indexOf(column.id);
      const move = offset => {
        const reordered = ids.slice();
        reordered.splice(at + offset, 0, reordered.splice(at, 1)[0]);
        void save(() => command({ action: 'reorder-columns', columnIds: reordered }, version), '已调整列顺序');
      };
      button(controls, '左移', () => move(-1)).disabled = at === 0;
      button(controls, '右移', () => move(1)).disabled = at === ids.length - 1;
      if (!column.items.length && !statuses.some(pair => pair[0] === column.id)) {
        button(controls, '移除空列', () => void save(() => command({ action: 'remove-column', columnId: column.id }, version), '已移除空列'));
      }
    }
    editor.showModal(); name.focus();
  }
  function drawCard(row, item, column, includeZone = false) {
    const card = element(row, 'button', undefined, 'card');
    card.type = 'button';
    card.addEventListener('click', () => itemEditor(item, column));
    element(card, 'span', item.title, 'card-title');
    const priority = priorities.find(pair => pair[0] === item.priority)?.[1];
    const deadline = item.dueDate || (item.dueAt && new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'short', timeStyle: 'short', timeZone: item.timeZone,
    }).format(new Date(item.dueAt)));
    const details = [item.priority !== 'normal' && priority && priority + '优先级', deadline,
      includeZone && item.dueAt && item.timeZone, item.assignee?.name].filter(Boolean);
    if (details.length) element(card, 'span', details.join(' · '), 'meta');
    return card;
  }
  function selectedMonth() {
    return String(agendaMonth.getFullYear()).padStart(4, '0') + '-' + String(agendaMonth.getMonth() + 1).padStart(2, '0');
  }
  function renderDeadlines() {
    const month = selectedMonth();
    get('deadline-month').textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(agendaMonth);
    const entries = board.columns.flatMap(column => column.items
      .filter(item => item.dueDay?.startsWith(month + '-'))
      .map(item => ({ day: item.dueDay, time: item.dueAt || '', title: item.title, item, column })));
    if (externalCalendar?.configured) {
      entries.push(...externalCalendar.events.map(event => ({ day: event.day, time: event.allDay ? '' : event.start, title: event.title, event })));
    }
    entries.sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title));
    if (!entries.length) element(panel, 'p', externalCalendar?.configured ? '本月没有截止时间或外部日程' : '本月没有设定截止时间的工作项', 'empty');
    let currentDay, cards;
    for (const { day: entryDay, item, column, event } of entries) {
      if (entryDay !== currentDay) {
        currentDay = entryDay;
        const day = element(panel, 'section', undefined, 'day');
        const title = element(day, 'h2', currentDay);
        title.id = 'deadline-day-' + currentDay;
        day.setAttribute('aria-labelledby', title.id);
        cards = element(day, 'ol', undefined, 'cards');
      }
      const row = element(cards, 'li');
      if (event) {
        const card = element(row, 'article', undefined, 'card');
        element(card, 'span', event.title);
        const time = event.allDay
          ? '全天 · ' + event.start + ' 至 ' + new Date(Date.parse(event.end) - 86_400_000).toISOString().slice(0, 10)
          : new Intl.DateTimeFormat('zh-CN', {
            timeZone: externalCalendar.timeZone, dateStyle: 'short', timeStyle: 'short',
          }).formatRange(new Date(event.start), new Date(event.end));
        element(card, 'span', 'Google 日历 · ' + time, 'meta');
      } else drawCard(row, item, column, true);
    }
  }
  async function loadCalendar() {
    calendarRead?.abort();
    const controller = new AbortController();
    calendarRead = controller;
    externalCalendar = undefined;
    get('calendar-status').textContent = '正在读取外部日程';
    render();
    try {
      const data = await request('calendar?month=' + selectedMonth(), 'GET', undefined, controller.signal);
      if (controller.signal.aborted) return;
      externalCalendar = data;
      get('calendar-status').textContent = '';
      render();
    } catch (error) {
      if (!controller.signal.aborted) get('calendar-status').textContent = error.message;
    }
  }
  function render() {
    panel.replaceChildren();
    panel.classList.toggle('deadlines', viewingDeadlines);
    get('deadline-controls').hidden = !viewingDeadlines;
    get('calendar-status').hidden = !viewingDeadlines;
    get('deadlines').setAttribute('aria-pressed', String(viewingDeadlines));
    if (viewingDeadlines) { renderDeadlines(); return; }
    for (const column of board.columns) {
      const lane = element(panel, 'section', undefined, 'column');
      const head = element(lane, 'div', undefined, 'column-head');
      const heading = element(head, 'h2', column.title);
      heading.id = 'col-' + column.id; lane.setAttribute('aria-labelledby', heading.id);
      element(heading, 'span', String(column.items.length), 'count');
      const options = button(head, '列选项', () => columnEditor(column), 'quiet');
      options.setAttribute('aria-label', column.title + '的列选项');
      const cards = element(lane, 'ol', undefined, 'cards');
      if (!column.items.length) element(cards, 'li', '当前无工作项', 'empty');
      for (const item of column.items) {
        const row = element(cards, 'li'); row.dataset.item = item.id;
        const card = drawCard(row, item, column);
        card.draggable = true;
        card.addEventListener('dragstart', event => {
          if (busy) { event.preventDefault(); return; }
          dragged = { itemId: item.id, itemRevision: item.revision, version: board.version };
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', item.id);
        });
        card.addEventListener('dragend', () => { dragged = undefined; lane.classList.remove('over'); });
      }
      lane.addEventListener('dragover', event => {
        if (!dragged || busy) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; lane.classList.add('over');
      });
      lane.addEventListener('dragleave', event => { if (!lane.contains(event.relatedTarget)) lane.classList.remove('over'); });
      lane.addEventListener('drop', event => {
        event.preventDefault(); lane.classList.remove('over');
        if (!dragged) return;
        const { itemId, itemRevision, version } = dragged;
        dragged = undefined;
        const beforeId = event.target.closest('[data-item]')?.dataset.item;
        if (beforeId === itemId) return;
        void save(() => command({ action: 'move-card', itemId, itemRevision, columnId: column.id, beforeId: beforeId || null }, version), '已移动工作项');
      });
    }
  }
  get('add-item').addEventListener('click', () => itemEditor());
  get('add-column').addEventListener('click', () => columnEditor());
  get('deadlines').addEventListener('click', () => {
    viewingDeadlines = !viewingDeadlines;
    if (viewingDeadlines) void loadCalendar();
    else { calendarRead?.abort(); render(); }
  });
  function shiftMonth(offset) {
    agendaMonth = new Date(agendaMonth.getFullYear(), agendaMonth.getMonth() + offset, 1);
    void loadCalendar();
  }
  get('deadline-prev').addEventListener('click', () => shiftMonth(-1));
  get('deadline-today').addEventListener('click', () => { agendaMonth = new Date(); void loadCalendar(); });
  get('deadline-next').addEventListener('click', () => shiftMonth(1));
  get('refresh').addEventListener('click', async () => {
    await save(async () => {}, '已刷新', false);
    if (viewingDeadlines) await loadCalendar();
  });
  get('close-editor').addEventListener('click', () => editor.close());
  async function openBoard() {
    const ticket = location.hash.slice(1);
    if (ticket) {
      history.replaceState(null, '', location.pathname);
      token = (await request('session', 'POST', { ticket })).token;
      sessionStorage.setItem(accessKey, token);
    } else token = sessionStorage.getItem(accessKey);
    if (!token) throw new Error('请从 Kada 的 work-items board-link 打开项目看板。');
    await refresh();
    setStatus('');
  }
  openBoard().catch(error => setStatus(error.message, true));
  </script>
</body>
</html>`;
