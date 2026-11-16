const state = {
  items: [],
  auth: null,
  loading: false,
  busy: false,
  error: '',
  notice: '',
  selected: new Set(),
  userId: null,
  fetchedAt: null,
  projects: [],
  repositoryId: '',
  pending: [],
};
const pending = new Map();
let sequence = 0;

function byId(id) {
  return document.getElementById(id);
}

function on(id, type, handler) {
  const node = byId(id);
  if (!node) {
    console.warn(`[witops-core] 面板缺少元素 #${id}，跳过 ${type} 绑定`);
    return;
  }
  node.addEventListener(type, handler);
}

function rpc(method, path, body) {
  const id = `r${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ type: 'trellis:request', id, method, path, body }, '*');
  });
}

let credentialsWidget = null;
function mountCredentials() {
  const root = byId('credentials');
  if (!root || !window.TrellisCredentialsWidget) return;
  credentialsWidget = window.TrellisCredentialsWidget.mount({
    root,
    request: rpc,
    systemId: 'witops',
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'trellis:init') {
    document.documentElement.dataset.theme = message.theme || 'light';
    void load(false);
    mountCredentials();
    return;
  }
  if (message.type === 'trellis:response') {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new Error(message.data?.error || `请求失败（${message.status}）`));
  }
});

function span(className, text) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function cell(className, content) {
  const node = document.createElement('td');
  if (className) node.className = className;
  if (typeof content === 'string') node.textContent = content;
  else node.append(content);
  return node;
}

function itemKey(item) {
  return `${item.type}:${item.id}`;
}

function dispatchable(item) {
  return item.kind === 'task' && !(Array.isArray(item.trellisTasks) && item.trellisTasks.length);
}

function visibleItems() {
  const wantsRequirements = byId('show-requirements').checked;
  const wantsTasks = byId('show-tasks').checked;
  return state.items.filter((item) => (
    (item.kind === 'requirement' && wantsRequirements)
    || (item.kind === 'task' && wantsTasks)
  ));
}

function authLabel(auth) {
  if (!auth) return '未登录';
  if (auth.status === 'authenticated') {
    return auth.account ? `${auth.account} · 已登录` : '已登录';
  }
  if (auth.mode === 'token') return auth.status === 'token-expired' ? 'token 已失效' : 'token 模式';
  if (auth.status === 'expired') return '会话过期';
  return '未登录';
}

function renderAuth() {
  const auth = state.auth;
  byId('auth-chip').textContent = authLabel(auth);
  byId('auth-chip').dataset.state = auth?.status || 'anonymous';
  const needsLogin = auth?.mode !== 'token' && auth?.status !== 'authenticated';
  byId('login').hidden = !needsLogin;
  byId('logout').hidden = auth?.status !== 'authenticated';
  if (needsLogin) {
    byId('login-hint').textContent = auth?.hasStoredPassword
      ? '已保存加密密码；可直接登录，或点登录复用。'
      : '密码默认不落盘；勾选记住密码后用宿主密钥加密保存。';
  }
}

function summarizeOutcome(result, label) {
  const summary = result?.summary ?? {};
  const parts = [];
  if (summary.imported) parts.push(`创建 ${summary.imported}`);
  if (summary.duplicated) parts.push(`已存在 ${summary.duplicated}`);
  if (summary.skipped) parts.push(`跳过 ${summary.skipped}`);
  if (summary.failed) parts.push(`失败 ${summary.failed}`);
  const failures = (result?.results ?? []).filter((row) => row.status === 'failed');
  if (!failures.length) {
    return { notice: parts.length ? `${label}：${parts.join('，')}` : label, error: '' };
  }
  const first = failures[0];
  const reason = String(first.reason || '').split('\n')[0].slice(0, 160);
  const who = first.code || first.businessId || '';
  return {
    notice: parts.length ? `${label}：${parts.join('，')}` : label,
    error: `${who ? `${who}：` : ''}${reason}${failures.length > 1 ? `（共 ${failures.length} 个失败）` : ''}`,
  };
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function storyCell(item) {
  const linked = Array.isArray(item.trellisTasks) && item.trellisTasks.length ? item.trellisTasks[0] : null;
  const code = item.storyCode || linked?.storyCode || '';
  const name = item.storyName || linked?.storyName || '';
  const url = item.storyUrl || linked?.storyUrl || '';
  const node = cell('story', '');
  if (!code && !url) {
    node.textContent = '—';
    return node;
  }
  const label = code || '需求';
  if (url) {
    const link = document.createElement('a');
    link.className = 'story-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = label;
    if (name) link.title = `${label} ${name}`;
    node.append(link);
  } else {
    node.append(span('code', label));
  }
  if (name) {
    const sub = span('story-name', name);
    sub.title = name;
    node.append(sub);
  }
  return node;
}

function render() {
  renderAuth();
  const rows = byId('rows');
  rows.replaceChildren();
  const items = visibleItems();
  byId('empty').hidden = items.length > 0;

  for (const item of items) {
    const tr = document.createElement('tr');

    const pickCell = document.createElement('td');
    pickCell.className = 'pick';
    if (dispatchable(item)) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.selected.has(itemKey(item));
      box.dataset.key = itemKey(item);
      box.addEventListener('change', () => {
        if (box.checked) state.selected.add(itemKey(item));
        else state.selected.delete(itemKey(item));
        render();
      });
      pickCell.append(box);
    }
    tr.append(pickCell);

    const code = document.createElement('div');
    code.className = 'code-line';
    code.append(
      span(`kind ${item.kind === 'task' ? 'task' : 'req'}`, item.kind === 'task' ? '任务' : '需求'),
      span('code', item.code || item.id || '—')
    );
    const due = item.dueDate || item.trellisTasks?.[0]?.dueDate || '—';
    tr.append(cell('code', code), cell('title', item.title || '—'), cell('', item.status || '—'), cell('', due), cell('', item.assignee || '—'));
    tr.append(storyCell(item));

    const trellis = document.createElement('td');
    trellis.className = 'trellis';
    if (Array.isArray(item.trellisTasks) && item.trellisTasks.length) {
      const wrap = document.createElement('div');
      wrap.className = 'trellis-cell';
      for (const task of item.trellisTasks) {
        const dir = task.taskKey.split('::')[1] || task.taskKey;
        const short = dir.replace(/^\d{2}-\d{2}-/, '');
        const badge = span('badge', `${short} · ${task.status || 'unknown'}`);
        badge.title = `${dir} · ${task.status || 'unknown'}`;
        wrap.append(badge);
      }
      trellis.append(wrap);
    } else if (item.kind === 'task') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'small';
      button.textContent = state.busy ? '创建中…' : '创建任务';
      button.disabled = state.busy;
      button.addEventListener('click', () => openDispatchDialog([item]));
      trellis.append(button);
    } else {
      trellis.textContent = '未关联';
    }
    tr.append(trellis);
    rows.append(tr);
  }

  const selected = state.selected.size;
  byId('selected-count').textContent = selected ? `已选 ${selected} 项` : '未选择';
  byId('dispatch-selected').disabled = state.busy || selected === 0;
  byId('sync').disabled = state.busy || state.loading;
  byId('refresh').disabled = state.busy || state.loading;
  byId('select-all').checked = items.length > 0 && items.filter(dispatchable).every((item) => state.selected.has(itemKey(item)));

  const meta = state.error
    ? state.error
    : `${state.items.length} 项 · 用户 ${state.userId ?? '—'} · ${state.fetchedAt || '—'}`;
  byId('meta').textContent = meta;
  byId('error').hidden = !state.error;
  byId('error').textContent = state.error;
  byId('notice').hidden = !state.notice;
  byId('notice').textContent = state.notice;
}

async function loadProjects() {
  try {
    const data = await rpc('GET', '/projects');
    state.projects = Array.isArray(data?.projects) ? data.projects : [];
    state.repositoryId = state.repositoryId
      || data?.defaultRepositoryId
      || state.projects[0]?.repositoryId
      || '';
  } catch {
    state.projects = [];
  }
  renderProjects();
}

function renderProjects() {
  const select = byId('dialog-project');
  if (!select) return;
  select.replaceChildren();
  const current = state.repositoryId || state.projects[0]?.repositoryId || '';
  for (const project of state.projects) {
    const option = document.createElement('option');
    option.value = project.repositoryId;
    option.textContent = project.name || project.repositoryId;
    option.selected = project.repositoryId === current;
    select.append(option);
  }
}

function openDispatchDialog(items) {
  if (!items.length) return;
  state.pending = items;
  byId('dialog-hint').textContent = items.length === 1
    ? `${items[0].code || items[0].id} · ${items[0].title || ''}`.slice(0, 80)
    : `将批量创建 ${items.length} 个任务`;
  renderProjects();
  byId('dialog-due').value = items.length === 1 ? (items[0].dueDate || '') : '';
  byId('dialog').hidden = false;
}

function closeDispatchDialog() {
  byId('dialog').hidden = true;
  state.pending = [];
}

async function load(force) {
  if (state.loading) return;
  state.loading = true;
  state.error = '';
  render();
  try {
    state.auth = await rpc('GET', '/auth');
    if (force) await rpc('POST', '/refresh', {});
    const data = await rpc('GET', force ? '/mine?refresh=1' : '/mine');
    state.items = Array.isArray(data?.items) ? data.items : [];
    state.userId = data?.userId ?? null;
    state.fetchedAt = data?.fetchedAt ?? null;
    if (!state.projects.length) await loadProjects();
    const keys = new Set(state.items.filter(dispatchable).map(itemKey));
    state.selected = new Set([...state.selected].filter((key) => keys.has(key)));
  } catch (error) {
    state.error = error.message || '加载失败';
  } finally {
    state.loading = false;
    render();
  }
}

async function dispatchItems(items, options = {}) {
  if (state.busy || !items.length) return;
  state.busy = true;
  state.error = '';
  state.notice = '';
  render();
  let notice = '';
  let errorText = '';
  try {
    const payload = items.map((item) => ({
      type: item.type,
      businessId: item.id,
      repositoryId: options.repositoryId || state.repositoryId || undefined,
      dueDate: options.dueDate || undefined,
    }));
    const result = await rpc('POST', '/dispatch', { items: payload });
    const outcome = summarizeOutcome(result, '创建完成');
    notice = outcome.notice;
    errorText = outcome.error;
    state.selected.clear();
  } catch (error) {
    errorText = error.message || '创建失败';
  } finally {
    state.busy = false;
    await load(true);
    state.notice = notice;
    state.error = errorText;
    render();
  }
}

on('refresh', 'click', () => void load(true));
on('show-requirements', 'change', render);
on('show-tasks', 'change', render);
on('logout', 'click', async () => {
  try {
    state.auth = (await rpc('POST', '/logout', {}))?.auth ?? null;
    state.notice = '已退出登录';
  } catch (error) {
    state.error = error.message || '退出失败';
  }
  render();
});
on('select-all', 'change', (event) => {
  if (event.target.checked) {
    for (const item of visibleItems()) if (dispatchable(item)) state.selected.add(itemKey(item));
  } else {
    state.selected.clear();
  }
  render();
});
on('dispatch-selected', 'click', () => {
  const items = state.items.filter((item) => dispatchable(item) && state.selected.has(itemKey(item)));
  openDispatchDialog(items);
});
on('dialog-cancel', 'click', closeDispatchDialog);
on('dialog', 'click', (event) => {
  if (event.target === byId('dialog')) closeDispatchDialog();
});
on('dialog-form', 'submit', (event) => {
  event.preventDefault();
  const items = state.pending.slice();
  const repositoryId = byId('dialog-project').value;
  const dueDate = byId('dialog-due').value.trim();
  if (dueDate && !isCalendarDate(dueDate)) {
    state.error = '截止日期格式应为 YYYY-MM-DD';
    byId('dialog-due').focus();
    render();
    return;
  }
  state.error = '';
  closeDispatchDialog();
  void dispatchItems(items, { repositoryId, dueDate });
});
on('sync', 'click', async () => {
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  state.notice = '';
  render();
  let notice = '';
  let errorText = '';
  try {
    const result = await rpc('POST', '/sync', { size: 20 });
    const outcome = summarizeOutcome(result, '同步完成');
    notice = outcome.notice;
    errorText = outcome.error;
  } catch (error) {
    errorText = error.message || '同步失败';
  } finally {
    state.busy = false;
    await load(true);
    state.notice = notice;
    state.error = errorText;
    render();
  }
});
on('login', 'submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  state.error = '';
  state.notice = '';
  render();
  try {
    const result = await rpc('POST', '/login', {
      account: byId('account').value.trim(),
      password: byId('password').value,
      remember: byId('remember').checked,
    });
    state.auth = result?.auth ?? null;
    byId('password').value = '';
    state.notice = '登录成功';
    await credentialsWidget?.refresh();
  } catch (error) {
    state.error = error.message || '登录失败';
  } finally {
    state.busy = false;
    await load(false);
  }
});

render();
