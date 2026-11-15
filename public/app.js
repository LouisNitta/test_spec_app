'use strict';

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// YAML の値をそのまま表示する
const LABEL = {
  perspective: { 正常: '正常', 異常: '異常' },
  execution: { 自動: '自動', 手動: '手動' },
  status: { 有効: '有効', 無効: '無効' },
  level: { ita: 'ITA', itb: 'ITB' },
};
// 区分・種別の色
const TONE = { 正常: 'tone-green', 異常: 'tone-red', 自動: 'tone-blue', 手動: 'tone-orange' };
const TYPE_LABEL = { added: '追加', changed: '変更', excluded: '無効化', removed: '削除', same: '変更なし' };

// 差分・変更検知の対象項目
const COMMON_FIELDS = [
  { path: 'no', label: 'No', kind: 'text' },
  { path: 'title', label: 'ケース名', kind: 'text' },
  { path: 'description', label: 'テスト概要', kind: 'text' },
  { path: 'perspective', label: '区分', kind: 'enum' },
  { path: 'execution', label: '実行方法', kind: 'enum' },
  { path: 'status', label: '状態', kind: 'enum' },
];
const NOTES_FIELD = { path: 'notes', label: '備考', kind: 'items' };
const FIELDS = {
  api: [
    ...COMMON_FIELDS,
    { path: 'request.path', label: 'リクエスト · パス', kind: 'text' },
    { path: 'request.headers', label: 'リクエスト · Headers', kind: 'json' },
    { path: 'request.body', label: 'リクエスト · Body', kind: 'json' },
    { path: 'expected', label: '期待値', kind: 'items' },
    NOTES_FIELD,
  ],
  ui: [...COMMON_FIELDS, { path: 'steps', label: '手順・期待値', kind: 'steps' }, NOTES_FIELD],
};
const specType = (spec) => spec?.meta.type ?? 'api';
const fieldsOf = (spec) => FIELDS[specType(spec)];

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k, i) => {
    o[k] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}
const isEmpty = (v) =>
  v == null || v === '' || (Array.isArray(v) ? !v.length : typeof v === 'object' && !Object.keys(v).length);
const same = (a, b) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b);
const shortLabel = (f) => f.label.split(' · ').at(-1);

// プライベートウィンドウなどで localStorage が使えなくても動くようにする
const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

// raw は JSON として読めなかった入力（キーは `ケースID|パス`）
// order はケースを並べ替えたときだけ持つ表示順（ID の配列）
const emptyDraft = () => ({ cases: new Map(), newIds: [], order: null, raw: {} });

const state = {
  tree: [],
  api: null,
  level: null,
  versions: [],
  version: null,
  etag: null, // 作業中のファイルを読み込んだ時点の内容。保存時に他で書き換えられていないかを確かめる
  spec: null,
  view: 'specs',
  mode: 'list', // list | read
  sidebarOpen: storage.get('testspec.sidebar') !== 'closed',
  selectedId: null,
  filters: { q: '', perspective: '', execution: '', status: '' },
  diff: { from: null, to: null, a: null, b: null, onlyChanged: true, selectedId: null, showSame: false },
  // 一覧・通し読みで編集中の内容。保存するまで版には書き込まない
  draft: emptyDraft(),
  changesOpen: false, // 画面下のバーの「変更の一覧」を開いているか
  // テストデータの定義（レベルごと）と、テストデータ画面で開いているテーブル
  dataDefs: {},
  dataSel: null, // { level, table, branch, v, caseId?, caseLabel? }
  dataView: null, // 選んだブランチ・版の時点のテーブル
  dataDraft: null, // テストデータの編集中の内容
  dataPicker: null, // 「使用しているケース」を追加する選択欄を開いているレコード { rec, name }
  // git のブランチ。編集できるのはチェックアウト中のブランチだけ
  branches: [],
  currentBranch: null,
  branch: null,
  versionsBy: {}, // ブランチごとの版の一覧（今開いている API・画面のもの）
  // テストデータの差分。dataVersionsBy はブランチごとの版の一覧（今開いているテーブルのもの）
  dataDiff: { onlyChanged: true },
  dataVersionsBy: {},
  // ディシジョンテーブル。dt は表示中のブランチ・版の内容、dtWorking はケースの詳細に出すラベル用（作業中の内容）
  dt: null,
  dtWorking: null,
  dtFocus: null, // 強調するルール { table, rule }
  dtListOpen: new Set(), // 「ルールとケースの対応」を開いている表のid
  dtVersionsBy: {},
  dtDiff: { onlyChanged: true },
  dtDraft: null, // ディシジョンテーブルの編集中の内容
};

async function request(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
const q = (v) => encodeURIComponent(v ?? '');
const specUrl = (v, branch = state.branch) => `/api/spec?api=${q(state.api)}&level=${state.level}&branch=${q(branch)}${v ? `&v=${q(v)}` : ''}`;
const latestVersion = () => state.versions.at(-1).id;
const isCurrentBranch = () => !state.currentBranch || state.branch === state.currentBranch;
const canEdit = () => isCurrentBranch() && state.version === latestVersion();

async function versionsOf(branch, force) {
  if (force || !state.versionsBy[branch]) {
    state.versionsBy[branch] = await request(`/api/versions?api=${q(state.api)}&level=${state.level}&branch=${q(branch)}`);
  }
  return state.versionsBy[branch];
}

async function selectSpec(api, level) {
  state.api = api;
  state.level = level;
  state.versionsBy = {};
  state.versions = await versionsOf(state.branch);
  // 選んでいるブランチにこのファイルがなければ、チェックアウト中のブランチに戻す
  if (!state.versions.length && !isCurrentBranch()) {
    toast(`${state.branch} にはこのファイルがないため、${state.currentBranch} を表示します`);
    state.branch = state.currentBranch;
    state.versions = await versionsOf(state.branch);
  }
  state.selectedId = null;
  state.draft = emptyDraft();
  state.dtVersionsBy = {};
  await Promise.all([loadVersion(latestVersion()), loadData(level, true), loadDtWorking()]);
  if (state.view === 'diff') return openDiff();
  // ディシジョンテーブルを見ているときは、別の API・画面でもディシジョンテーブルを開く
  if (state.view === 'dt' && hasDt()) return openDt();
  if (state.view === 'dt-diff' && hasDt()) return openDtDiff({ toBranch: state.branch });
  state.view = 'specs';
  render();
}

async function selectBranch(branch) {
  const versions = await versionsOf(branch);
  if (!versions.length) return toast(`${branch} にはこのファイルがありません`, true);
  state.branch = branch;
  state.versions = versions;
  await loadVersion(latestVersion());
  render();
}

async function loadData(level, force) {
  if (force || !state.dataDefs[level]) state.dataDefs[level] = await request(`/api/data?level=${level}`);
  return state.dataDefs[level];
}

const dataTableUrl = (level, table, branch, v) => `/api/data/table?level=${level}&table=${q(table)}&branch=${q(branch)}&v=${q(v)}`;

// ブランチと版を選んで、その時点のテーブルを表示する。省略したときは現在のブランチの最新
// filter を渡すと、そのケースで使うレコードだけを表示する
async function openData(level, table, { branch, v, ...filter } = {}) {
  branch ??= state.currentBranch;
  const versions = (await dataVersionsOf(level, table, branch, true)).map((x) => x.id);
  if (!versions.length) return toast(`${branch} にはこのテーブルがありません`, true);
  if (!versions.includes(v)) v = versions.at(-1);
  state.dataView = await request(dataTableUrl(level, table, branch, v));
  if (!hasDataDirty()) (state.dataDraft = null), (state.dataPicker = null);
  state.dataSel = { level, table, branch, v, ...filter };
  state.view = 'data';
  render();
}

async function dataVersionsOf(level, table, branch, force) {
  const key = `${level}|${table}|${branch}`;
  if (force || !state.dataVersionsBy[key]) {
    state.dataVersionsBy[key] = await request(`/api/data/versions?level=${level}&table=${q(table)}&branch=${q(branch)}`);
  }
  return state.dataVersionsBy[key];
}

// ケースの差分と同じく、比較先は一覧で見ているブランチ・版、比較元はその 1 つ前（別ブランチなら最新）
async function openDataDiff({ fromBranch, from, toBranch, to } = {}) {
  const { level, table } = state.dataSel;
  toBranch ??= state.dataSel.branch ?? state.currentBranch;
  fromBranch ??= toBranch;
  const toVs = (await dataVersionsOf(level, table, toBranch)).map((x) => x.id);
  const fromVs = (await dataVersionsOf(level, table, fromBranch)).map((x) => x.id);
  if (!toVs.includes(to)) to = toVs.at(-1);
  if (!fromVs.includes(from)) from = fromBranch === toBranch ? fromVs[Math.max(0, fromVs.indexOf(to) - 1)] : fromVs.at(-1);
  if (!from || !to) return toast('このブランチにはこのテーブルがありません', true);
  const [a, b] = await Promise.all([request(dataTableUrl(level, table, fromBranch, from)), request(dataTableUrl(level, table, toBranch, to))]);
  Object.assign(state.dataDiff, { level, table, fromBranch, from, toBranch, to, a, b });
  state.view = 'data-diff';
  render();
}

async function loadVersion(v) {
  state.version = v;
  state.spec = numbered(await request(specUrl(v)));
  state.etag = state.spec.etag ?? null;
  if (!state.spec.cases.some((c) => c.id === state.selectedId)) state.selectedId = null;
}

// 比較元・比較先はそれぞれブランチと版の組。省略したものは、比較先は今のブランチの最新、比較元はその 1 つ前（別ブランチなら最新）
async function openDiff({ fromBranch, from, toBranch, to } = {}) {
  toBranch ??= state.branch;
  fromBranch ??= toBranch;
  const toVs = (await versionsOf(toBranch)).map((x) => x.id);
  const fromVs = (await versionsOf(fromBranch)).map((x) => x.id);
  if (!toVs.includes(to)) to = toVs.at(-1);
  if (!fromVs.includes(from)) from = fromBranch === toBranch ? fromVs[Math.max(0, fromVs.indexOf(to) - 1)] : fromVs.at(-1);
  if (!from || !to) return toast('このブランチにはファイルがありません', true);
  const [a, b] = (await Promise.all([request(specUrl(from, fromBranch)), request(specUrl(to, toBranch))])).map(numbered);
  Object.assign(state.diff, { fromBranch, from, toBranch, to, a, b, selectedId: null, showSame: false });
  state.view = 'diff';
  render();
}

/* ---------- draft ---------- */

// 編集中はリストの項目を { text, code? } にそろえ、保存時に文字列へ戻す
const toEditItems = (items) => (items ?? []).map((x) => (typeof x === 'string' ? { text: x } : structuredClone(x)));
const fromEditItems = (items) => (items ?? []).map((x) => (isEmpty(x.code) ? x.text ?? '' : { text: x.text ?? '', code: x.code }));
function toEditCase(c) {
  const d = structuredClone(c);
  if (c.steps) d.steps = c.steps.map((s) => ({ action: s.action ?? '', expected: toEditItems(s.expected) }));
  else d.expected = toEditItems(c.expected);
  d.notes = toEditItems(c.notes);
  return d;
}
// no は YAML に持たない。読み込んだときに配列の順番から付け、保存するときに外す
const numbered = (spec) => ({ ...spec, cases: spec.cases.map((c, i) => ({ ...c, no: i + 1 })) });
const withoutNo = ({ no, ...c }) => c;
function fromEditCase(d) {
  const c = { ...d, notes: fromEditItems(d.notes) };
  if (d.steps) c.steps = d.steps.map((s) => (s.expected?.length ? { action: s.action, expected: fromEditItems(s.expected) } : { action: s.action }));
  else c.expected = fromEditItems(d.expected);
  return c;
}

const originalCase = (id) => state.spec.cases.find((c) => c.id === id);
const isNewCase = (id) => state.draft.newIds.includes(id);

// 画面に出すケース。編集中のものは下書きを優先する
const defaultOrder = () => [...state.spec.cases.map((c) => c.id), ...state.draft.newIds];
const orderedIds = () => state.draft.order ?? defaultOrder();
function currentCases() {
  return orderedIds().map(viewCase);
}
const viewCase = (id) => state.draft.cases.get(id) ?? toEditCase(originalCase(id));

// 並べ替えたら上から番号を振り直す。元の順に戻ったら並び順の下書きは捨てる
function reorderCases(ids) {
  ids.forEach((id, i) => {
    if (viewCase(id).no !== i + 1) ensureDraft(id).no = i + 1;
  });
  state.draft.order = ids.join() === defaultOrder().join() ? null : ids;
}

function ensureDraft(id) {
  const d = state.draft;
  if (!d.cases.has(id)) d.cases.set(id, toEditCase(originalCase(id)));
  return d.cases.get(id);
}

function changedPaths(id) {
  const draft = state.draft.cases.get(id);
  if (!draft || isNewCase(id)) return [];
  const a = originalCase(id);
  const b = fromEditCase(draft);
  return fieldsOf(state.spec)
    .filter((f) => !same(get(a, f.path), get(b, f.path)))
    .map((f) => f.path);
}
const rawKeys = (id) => Object.keys(state.draft.raw).filter((k) => k.startsWith(`${id}|`));
const isDirty = (id) => isNewCase(id) || changedPaths(id).length > 0 || rawKeys(id).length > 0;
const dirtyIds = () => [...state.draft.cases.keys()].filter(isDirty);
const hasDirty = () => dirtyIds().length > 0 || (state.dataDraft != null && hasDataDirty()) || hasDtDirty();

// 項目ごとに戻せるのは、並び順（no）と状態（有効・無効の切り替えボタンで戻せる）以外の項目
const REVERTIBLE = (path) => path !== 'no' && path !== 'status';

// 1つの項目だけ保存済みの内容に戻す。入力途中の JSON も捨てる
function revertField(id, path) {
  const original = toEditCase(originalCase(id));
  set(ensureDraft(id), path, structuredClone(get(original, path)));
  delete state.draft.raw[`${id}|${path}`];
  dropRaw(id, path);
}

// ケースの変更をすべて戻す。追加したケースは追加を取り消す。並べ替えていたら番号だけは今の並び順に合わせる
function revertCase(id) {
  const d = state.draft;
  d.cases.delete(id);
  rawKeys(id).forEach((k) => delete d.raw[k]);
  if (isNewCase(id)) {
    d.newIds = d.newIds.filter((x) => x !== id);
    if (d.order) d.order = d.order.filter((x) => x !== id);
    if (state.selectedId === id) state.selectedId = null;
  }
  if (d.order) reorderCases(d.order);
}

// 並び順だけを元に戻す
function revertOrder() {
  state.draft.order = null;
  reorderCases(defaultOrder());
  [...state.draft.cases.keys()].forEach((id) => isDirty(id) || state.draft.cases.delete(id));
}
const isReordered = () => !!state.draft.order;

function newCaseTemplate() {
  const nos = currentCases().map((c) => c.no);
  return {
    id: crypto.randomUUID(),
    no: Math.max(0, ...nos) + 1,
    status: '有効',
    perspective: '正常',
    execution: '自動',
    title: '',
    description: '',
    ...(specType(state.spec) === 'ui'
      ? { steps: [{ action: '', expected: [] }] }
      : { request: { path: state.spec.meta.path, headers: {}, body: {} }, expected: [] }),
    notes: [],
  };
}

/* ---------- render ---------- */

// 入力欄を DOM から外すと focusout が起きるので、描き直しや確定の最中は確定処理を走らせない
let suppressCommit = false;

function render() {
  suppressCommit = true;
  try {
    renderAll();
  } finally {
    suppressCommit = false;
  }
}

function renderAll() {
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((el) => (scrolls[el.dataset.scroll] = el.scrollTop));

  document.body.classList.toggle('sidebar-closed', !state.sidebarOpen);
  document.body.classList.toggle('specs-view', state.view === 'specs');
  renderSidebar();
  $('#main').innerHTML = { diff: renderDiff, data: renderData, 'data-diff': renderDataDiff, dt: renderDt, 'dt-diff': renderDtDiff }[state.view]?.() ?? renderSpecs();

  document.querySelectorAll('[data-scroll]').forEach((el) => {
    if (scrolls[el.dataset.scroll] != null) el.scrollTop = scrolls[el.dataset.scroll];
  });
  if (state.view === 'specs' && state.mode === 'read') $('.reading')?.addEventListener('scroll', onReadingScroll, { passive: true });
  if (state.view === 'specs') dirtyIds().forEach(syncDirty);
  updateSaveBar();
}

// サーバー名の下に、名前（〇〇API / 〇〇画面）とレベルを並べる
function renderSidebar() {
  const { server, items } = state.tree;
  $('#sidebar').innerHTML =
    `<div class="side-title"><span class="server">${esc(server)}</span><span>${items.length}</span></div>` +
    items
      .map(
        (t) => `<div class="api">
        <div class="api-name">${esc(t.name)}</div>
        ${t.levels
          .map(
            (l) => `<button class="level ${!state.view.startsWith('data') && l.api === state.api && l.level === state.level ? 'active' : ''}"
              data-act="level" data-api="${esc(l.api)}" data-level="${l.level}">${LABEL.level[l.level]}<span>${l.count}</span></button>`,
          )
          .join('')}
      </div>`,
      )
      .join('') +
    renderDataSidebar();
}

function renderDataSidebar() {
  const tables = state.tree.data ?? [];
  if (!tables.length) return '';
  const sel = state.view === 'data' ? state.dataSel : state.view === 'data-diff' ? state.dataDiff : null;
  return (
    `<div class="side-title data-title"><span>テストデータ</span><span>${tables.length}</span></div>` +
    tables
      .map(
        (t) => `<div class="api">
        <div class="api-name mono">${esc(t.table)}</div>
        ${t.levels
          .map(
            (l) => `<button class="level ${sel?.table === t.table && sel?.level === l.level ? 'active' : ''}"
              data-act="data-table" data-table="${esc(t.table)}" data-level="${l.level}">${LABEL.level[l.level]}<span>${l.count}</span></button>`,
          )
          .join('')}
      </div>`,
      )
      .join('')
  );
}

// 見方の切り替え。何を見るかは左のサイドバー、どう見るかはここで選ぶ
const caseModeSwitch = () => {
  const cur = state.view === 'diff' ? 'diff' : state.mode;
  const b = (mode, label) => `<button data-act="mode" data-mode="${mode}" class="${cur === mode ? 'on' : ''}">${label}</button>`;
  return `<div class="seg mode-switch">${b('list', '一覧')}${b('read', '通し読み')}${b('diff', '差分')}</div>`;
};
const dataModeSwitch = () => {
  const b = (view, label) => `<button data-act="data-mode" data-view-to="${view}" class="${state.view === view ? 'on' : ''}">${label}</button>`;
  return `<div class="seg mode-switch data-mode">${b('data', '一覧')}${b('data-diff', '差分')}</div>`;
};

// ブランチの選択欄。git 管理外なら出さない
const branchSelect = (act, cur) =>
  state.branches.length
    ? `<select data-act="${act}" class="branch-select" title="ブランチ">${state.branches
        .map((b) => `<option value="${esc(b)}" ${b === cur ? 'selected' : ''}>${esc(b)}${b === state.currentBranch ? '（現在のブランチ）' : ''}</option>`)
        .join('')}</select>`
    : '';

const crumb = (extra = '') =>
  `<div class="crumb">${esc(state.spec.meta.name)}<span class="sep">/</span>${LABEL.level[state.level]}${extra}</div>`;

function filteredCases() {
  const { q, perspective, execution, status } = state.filters;
  return currentCases().filter(
    (c) =>
      (!q || `${c.no} ${c.title} ${c.description ?? ''}`.toLowerCase().includes(q.toLowerCase())) &&
      (!perspective || c.perspective === perspective) &&
      (!execution || c.execution === execution) &&
      (!status || c.status === status),
  );
}

function filterSelect(key, label) {
  const opts = Object.entries(LABEL[key])
    .map(([v, l]) => `<option value="${v}" ${state.filters[key] === v ? 'selected' : ''}>${label}: ${l}</option>`)
    .join('');
  return `<select data-filter="${key}"><option value="">${label}: すべて</option>${opts}</select>`;
}

function renderSpecs() {
  const cases = currentCases();
  const count = (k, v) => cases.filter((c) => c[k] === v).length;
  const sel = cases.find((c) => c.id === state.selectedId);
  const rows = filteredCases()
    .map(
      (c) => `<tr data-act="select" data-id="${c.id}" class="${c.id === state.selectedId ? 'selected' : ''} ${c.status === '無効' ? 'excluded' : ''}">
        <td class="c-no">${caseHandle()}#${c.no}</td>
        <td class="c-title">${esc(c.title || '（未入力）')}</td>
        <td class="c-data">${dataSummary(c)}</td>
        <td class="c-col">${pill(c, 'perspective')}</td>
        <td class="c-col">${pill(c, 'execution')}</td>
      </tr>`,
    )
    .join('');

  const body =
    state.mode === 'read'
      ? `<div class="specs-body read">${renderReading()}</div>`
      : `<div class="specs-body ${sel ? 'with-detail' : ''}">
          <div class="table-wrap" data-scroll="cases">
            <table class="cases">
              <thead><tr><th class="c-no">No</th><th>ケース名</th><th>テストデータ</th><th>区分</th><th>種別</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="5" class="empty">該当するケースはありません</td></tr>'}</tbody>
            </table>
          </div>
          ${sel ? renderDetail(sel) : ''}
        </div>`;

  return `<div class="specs">
    <div class="specs-head">
      <div class="pane-head">
        ${crumb()}
        ${paneTabs()}
        <div class="spacer"></div>
        ${caseModeSwitch()}
      </div>
      <div class="pane-head sub">
        ${branchSelect('branch', state.branch)}
        <select data-act="version">${state.versions
          .map((v) => `<option value="${v.id}" ${v.id === state.version ? 'selected' : ''}>${esc(v.label)}${v.id === latestVersion() ? ' · 最新' : ''}</option>`)
          .join('')}</select>
        <div class="spacer"></div>
        <button class="btn primary" data-act="new-case" ${canEdit() ? '' : 'disabled'}>ケースを追加</button>
      </div>
      ${
        canEdit()
          ? ''
          : `<div class="note warn">${
              isCurrentBranch()
                ? '過去の版を表示しています。編集は最新版でのみ行えます。'
                : `現在のブランチ（${esc(state.currentBranch)}）以外のブランチ（${esc(state.branch)}）を表示しています。編集できるのは現在のブランチだけです。`
            }</div>`
      }
      <div class="toolbar">
        <div class="summary">${cases.length}件 · 有効 ${count('status', '有効')} · 異常 ${count('perspective', '異常')} · 手動 ${count('execution', '手動')}</div>
        <input class="search" data-filter="q" placeholder="ケースを絞り込み" value="${esc(state.filters.q)}">
        ${filterSelect('perspective', '区分')}${filterSelect('execution', '種別')}${filterSelect('status', '状態')}
      </div>
    </div>
    ${body}
  </div>`;
}

/* ---------- case parts ---------- */

// `値` をインラインのコードとして表示する
const inline = (text) => esc(text).replace(/`([^`]+)`/g, '<code class="ic">$1</code>');
const itemText = (x) => (typeof x === 'string' ? x : x.text);
const itemCode = (x) => (typeof x === 'string' || isEmpty(x.code) ? null : x.code);

function highlight(src) {
  return esc(src).replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(-?\d+(?:\.\d+)?|true|false|null)\b/g,
    (m, str, colon, lit) => (str ? `<span class="${colon ? 'k' : 's'}">${str}</span>${colon ?? ''}` : `<span class="n">${lit}</span>`),
  );
}
const code = (v) => `<pre class="code">${highlight(JSON.stringify(v, null, 2))}</pre>`;
const kv = (label, html) => (html ? `<div class="kv"><div class="kv-label">${label}</div><div>${html}</div></div>` : '');

// 編集できる要素の表示内容。kind は line（1行）/ para（複数行）/ json
function displayHtml(c, path, kind, placeholder) {
  const raw = state.draft.raw[`${c.id}|${path}`];
  const v = get(c, path);
  let html;
  if (kind === 'json') html = raw != null ? `<pre class="code">${esc(raw)}</pre>` : isEmpty(v) ? '' : code(v);
  else html = inline(v ?? '');
  return html || `<span class="placeholder">${esc(placeholder)}</span>`;
}

// 最新版のときだけ、クリックで編集できる要素にする
function ed(c, path, kind, { placeholder = '（未入力）', cls = '', field = '' } = {}) {
  const fieldAttr = field ? `data-field="${field}"` : '';
  if (!canEdit()) {
    const v = get(c, path);
    return `<div class="${cls}" ${fieldAttr}>${kind === 'json' ? (isEmpty(v) ? '' : code(v)) : inline(v ?? '')}</div>`;
  }
  const invalid = `${c.id}|${path}` in state.draft.raw;
  return `<div class="editable ${kind} ${cls} ${invalid ? 'invalid' : ''}" ${fieldAttr} data-edit="${path}" data-kind="${kind}"
    data-ph="${esc(placeholder)}" tabindex="0">${displayHtml(c, path, kind, placeholder)}</div>`;
}

const ctlBtn = (act, path, label, extra = '') => `<button type="button" data-act="${act}" data-path="${path}" ${extra}>${label}</button>`;
const addBtn = (act, path, label, cls = '') => `<button type="button" class="ctl-add ${cls}" data-act="${act}" data-path="${path}">${label}</button>`;
// 「+ JSON」を押した直後（code: null）も入力欄を出す
const hasCode = (c, p, x) => x.code !== undefined || `${c.id}|${p}.code` in state.draft.raw;

function itemHtml(x, collapseCode = false) {
  const c = itemCode(x);
  if (!c) return inline(itemText(x));
  return collapseCode ? `<details><summary>${inline(x.text)}</summary>${code(c)}</details>` : `${inline(x.text)}${code(c)}`;
}

// 1項目分の編集UI。文字列と、必要なら JSON を持つ
function itemEditor(c, listPath, i, x, collapseCode) {
  const p = `${listPath}.${i}`;
  const withCode = hasCode(c, p, x);
  const codeEd = ed(c, `${p}.code`, 'json', { placeholder: 'JSONを入力' });
  return `<div class="item-row">${ed(c, `${p}.text`, 'line')}<span class="ctl">${withCode ? '' : ctlBtn('add-code', p, '+ JSON')}${ctlBtn(
    'remove-item',
    listPath,
    '×',
    `data-index="${i}" aria-label="削除"`,
  )}</span></div>${!withCode ? '' : collapseCode ? `<details class="code-toggle"><summary></summary>${codeEd}</details>` : codeEd}`;
}

// 期待値・備考のリスト。項目は文字列か { text, code }
function itemsHtml(c, path, collapseCode = false) {
  const items = get(c, path) ?? [];
  if (!canEdit()) {
    if (!items.length) return '<div class="muted">なし</div>';
    return `<ul class="items">${items.map((x) => `<li>${itemHtml(x, collapseCode)}</li>`).join('')}</ul>`;
  }
  const lis = items.map((x, i) => `<li>${itemEditor(c, path, i, x, collapseCode)}</li>`).join('');
  return items.length ? `<ul class="items">${lis}</ul>` : '<div class="muted">なし</div>';
}

// 見出しの横に追加ボタンを置き、リストの下に余計な高さを取らない
function label(text, path, tag = 'div') {
  const add = canEdit() ? addBtn('add-item', path, '+ 追加') : '';
  return tag === 'h3' ? `<h3>${text}${add}</h3>` : `<div class="rlabel">${text}${add}</div>`;
}

const reqPath = (c) =>
  `<div class="req-path"><span class="method">${esc(state.spec.meta.method)}</span>${ed(c, 'request.path', 'line', { field: 'request.path' })}</div>`;

// compact は通し読み用。Headers を折りたたんで縦幅を詰める
function requestHtml(c, compact = false) {
  const r = c.request ?? {};
  const showHeaders = canEdit() || !isEmpty(r.headers);
  const showBody = canEdit() || !isEmpty(r.body);
  const headersEd = ed(c, 'request.headers', 'json', { placeholder: 'Headers なし', field: 'request.headers' });
  const bodyEd = ed(c, 'request.body', 'json', { placeholder: 'Body なし', field: 'request.body' });
  const headers = !showHeaders
    ? ''
    : compact
      ? `<details class="kv"><summary>Headers (${Object.keys(r.headers ?? {}).length})</summary>${headersEd}</details>`
      : kv('Headers', headersEd);
  const body = !showBody ? '' : compact ? `<div class="kv">${bodyEd}</div>` : kv('Body', bodyEd);
  return reqPath(c) + headers + body;
}

// 期待値が複数ある手順は 3-a, 3-b のように枝番を振る
const subLabel = (n, i, len) => {
  if (len < 2) return '';
  const letter = String.fromCharCode(97 + i);
  return typeof n === 'number' ? `${n}-${letter}` : letter;
};
const stepsTable = (rows, stepHead = '') =>
  `<table class="steps"><thead><tr><th class="s-no">No</th><th>手順${stepHead}</th><th>期待値</th></tr></thead><tbody>${rows}</tbody></table>`;

// 差分表示にも使うので、編集UIは持たない
function stepRow(s, n, cls = '') {
  const exp = s.expected ?? [];
  const expHtml = exp.length
    ? exp.map((x, i) => `<div class="exp"><span class="sub">${subLabel(n, i, exp.length)}</span><div>${itemHtml(x)}</div></div>`).join('')
    : '<span class="muted">-</span>';
  return `<tr class="${cls}"><td class="s-no">${n}</td><td>${inline(s.action)}</td><td>${expHtml}</td></tr>`;
}

function stepsHtml(c) {
  const steps = c.steps ?? [];
  if (!canEdit()) return steps.length ? stepsTable(steps.map((s, i) => stepRow(s, i + 1)).join('')) : '<div class="muted">手順なし</div>';
  const rows = steps
    .map((s, i) => {
      const n = i + 1;
      const exp = s.expected ?? [];
      const path = `steps.${i}.expected`;
      const expHtml = exp
        .map((x, j) => `<div class="exp"><span class="sub">${subLabel(n, j, exp.length)}</span><div class="exp-body">${itemEditor(c, path, j, x, false)}</div></div>`)
        .join('');
      return `<tr data-step="${i}"><td class="s-no"><span class="drag" draggable="true" title="ドラッグで並べ替え">⠿</span>${n}</td>
        <td><div class="item-row">${ed(c, `steps.${i}.action`, 'line', { placeholder: '（手順を入力）' })}<span class="ctl">${ctlBtn(
          'remove-item',
          'steps',
          '×',
          `data-index="${i}" aria-label="手順を削除"`,
        )}</span></div></td>
        <td class="exp-cell">${expHtml || '<span class="muted">-</span>'}${addBtn('add-item', path, '+ 期待値', 'cell-add')}</td></tr>`;
    })
    .join('');
  return stepsTable(rows, addBtn('add-step', 'steps', '+ 手順を追加'));
}

const pill = (c, key) => `<span class="pill ${TONE[c[key]]}">${LABEL[key][c[key]]}</span>`;

function enumSelect(c, key) {
  const cls = TONE[c[key]] ?? '';
  if (!canEdit()) return pill(c, key);
  const opts = Object.entries(LABEL[key])
    .map(([v, l]) => `<option value="${v}" ${c[key] === v ? 'selected' : ''}>${l}</option>`)
    .join('');
  // select の中には戻すボタンを置けないので、data-field は外側の span に付ける
  return `<span class="field-wrap" data-field="${key}"><select class="inline-select pill ${cls}" data-edit="${key}" data-kind="enum">${opts}</select></span>`;
}
const caseMeta = (c) =>
  `<span class="case-meta">${enumSelect(c, 'perspective')}${enumSelect(c, 'execution')}</span>`;

const caseHandle = () => (canEdit() ? '<span class="drag case-drag" draggable="true" title="ドラッグで並べ替え">⠿</span>' : '');

const caseActions = (c) =>
  `<button class="uuid" data-act="copy-uuid" data-id="${c.id}" title="クリックでコピー">${c.id}</button>${
    !canEdit()
      ? ''
      : isNewCase(c.id)
        ? `<button class="link" data-act="drop-new" data-id="${c.id}">追加を取り消す</button>`
        : `<button class="link" data-act="toggle-status" data-id="${c.id}">${c.status === '無効' ? '有効に戻す' : '無効にする'}</button>`
  }`;

const caseTitle = (c) => ed(c, 'title', 'line', { placeholder: '（ケース名を入力）', cls: 'title', field: 'title' });
const caseDesc = (c) =>
  canEdit() || c.description ? ed(c, 'description', 'para', { placeholder: '（概要を入力）', cls: 'desc', field: 'description' }) : '';

function caseBody(c, compact) {
  if (specType(state.spec) === 'ui') {
    return compact
      ? `<div class="rcols ui">
          <div data-field="steps">${stepsHtml(c)}</div>
          <div data-field="notes">${label('備考', 'notes')}${itemsHtml(c, 'notes', true)}</div>
        </div>`
      : `<h3>手順・期待値</h3><div data-field="steps">${stepsHtml(c)}</div>${label('備考', 'notes', 'h3')}<div data-field="notes">${itemsHtml(c, 'notes')}</div>`;
  }
  return compact
    ? `<div class="rcols">
        <div><div class="rlabel">リクエスト</div>${requestHtml(c, true)}</div>
        <div data-field="expected">${label('期待値', 'expected')}${itemsHtml(c, 'expected')}</div>
        <div data-field="notes">${label('備考', 'notes')}${itemsHtml(c, 'notes', true)}</div>
      </div>`
    : `<h3>リクエスト</h3>${requestHtml(c)}${label('期待値', 'expected', 'h3')}<div data-field="expected">${itemsHtml(c, 'expected')}</div>${label(
        '備考',
        'notes',
        'h3',
      )}<div data-field="notes">${itemsHtml(c, 'notes')}</div>`;
}

/* ---------- test data ---------- */

const dataCounts = (c) => Object.entries(state.dataDefs[state.level]?.byCase[c.id] ?? {});

// 一覧の列。テーブル名と件数だけを短く出す
const dataSummary = (c) => {
  const counts = dataCounts(c);
  return counts.length
    ? counts.map(([table, n]) => `<span class="ds"><span class="mono">${esc(table)}</span> ${n}</span>`).join('')
    : '<span class="muted">-</span>';
};

// ケースで使うテストデータ。テストデータの CSV の cases 列から集計し、テーブルごとの件数だけを出す
function dataRefs(c, compact) {
  const counts = dataCounts(c);
  const chips = counts
    .map(
      ([table, n]) => `<button class="dref" data-act="open-case-data" data-table="${esc(table)}" data-id="${c.id}" title="${esc(table)} のうち、このケースで使うレコードを表示">
        <span class="k">${esc(table)}</span><span class="p">${n}件</span></button>`,
    )
    .join('');
  if (compact) return counts.length ? `<div class="rdata"><span class="rlabel">テストデータ</span><div class="chips">${chips}</div></div>` : '';
  return `<h3>テストデータ</h3><div class="ddata">${counts.length ? chips : '<span class="muted">なし</span>'}</div>`;
}

// `-` は任意、NULL は NULL、空のセルは空文字
function cellHtml(v) {
  if (v === '-') return '<span class="any" title="任意">-</span>';
  if (v === 'NULL') return '<span class="null">NULL</span>';
  if (v === '') return '<span class="empty" title="空文字">""</span>';
  return esc(v).replaceAll('\n', '<br>');
}

/* ---------- test data editing ---------- */

// 編集中のテーブル。rows は表示順のレコードで、追加したものに _new、削除したものに _deleted を付ける。保存するまでファイルには書き込まない
const plainRec = (r) => ({ id: r.id, purpose: r.purpose, cases: [...r.cases], values: { ...r.values } });
const canEditData = () => !!state.dataView?.etag;
const origRec = (id) => state.dataView.records.find((r) => r.id === id);
const dataRows = () => state.dataDraft?.rows ?? state.dataView.records.map(plainRec);
const dataRow = (id) => state.dataDraft.rows.find((r) => r.id === id);
function ensureDataDraft() {
  state.dataDraft ??= { rows: state.dataView.records.map(plainRec) };
  return state.dataDraft;
}
// 変更がなくなったら下書きを捨てる
function settleDataDraft() {
  if (!dataDirtyRows().length) state.dataDraft = null;
}

// 意図は __purpose、使用しているケースは __cases、値のセルはカラム名で表す
const PURPOSE = '__purpose';
const CASES = '__cases';
const cellOf = (r, col) => (col === PURPOSE ? r.purpose : col === CASES ? r.cases.join(' ') : (r.values[col] ?? ''));
function recChange(r) {
  if (r._new) return { type: 'added', cols: [] };
  if (r._deleted) return { type: 'removed', cols: [] };
  const o = origRec(r.id);
  const cols = [PURPOSE, CASES, ...state.dataView.columns].filter((c) => cellOf(o, c) !== cellOf(r, c));
  return cols.length ? { type: 'changed', cols } : null;
}
const dataDirtyRows = () => (state.dataDraft?.rows ?? []).filter(recChange);
const hasDataDirty = () => dataDirtyRows().length > 0;
const colLabel = (col) => (col === PURPOSE ? '意図' : col === CASES ? '使用しているケース' : col);

// cases 列のケースの id を、同じ時点のケースの一覧から解決する
function caseOfRef(view, ref) {
  for (const spec of view.catalog ?? []) {
    const c = spec.cases.find((x) => x.id === ref);
    if (c) return { ref, api: spec.api, name: spec.name, ...c };
  }
  return { ref, missing: true };
}
const resolveRef = (ref) => caseOfRef(state.dataView, ref);
// 該当するケースがない id は、先頭だけを出す
const shortId = (id) => String(id).slice(0, 8);
// 差分で出すケースの呼び名。番号はその時点の並び順で決まる
const refLabel = (view, ref) => {
  const c = caseOfRef(view, ref);
  return c.missing ? `${shortId(ref)}（該当するケースなし）` : `${c.name} #${c.no}`;
};
// 絞り込み中のケースが、表示中の時点にあるか
const refOfCase = (caseId) => (resolveRef(caseId).missing ? null : caseId);

function setCell(id, col, value) {
  const r = dataRow(id);
  if (col === PURPOSE) r.purpose = value;
  else r.values[col] = value;
}
function revertDataCell(id, col) {
  const r = dataRow(id);
  const o = origRec(id);
  if (col === PURPOSE) r.purpose = o.purpose;
  else if (col === CASES) r.cases = [...o.cases];
  else r.values[col] = o.values[col];
  settleDataDraft();
}
function revertDataRec(id) {
  const rows = state.dataDraft.rows;
  const i = rows.findIndex((r) => r.id === id);
  if (rows[i]._new) rows.splice(i, 1);
  else rows[i] = plainRec(origRec(id));
  settleDataDraft();
}
function newDataRec(base) {
  const { caseId } = state.dataSel;
  const ref = caseId && refOfCase(caseId);
  return base
    ? { ...plainRec(base), id: crypto.randomUUID(), _new: true }
    : { id: crypto.randomUUID(), purpose: '', cases: ref ? [ref] : [], values: Object.fromEntries(state.dataView.columns.map((c) => [c, '-'])), _new: true };
}

async function saveDataDraft() {
  const { level, table, branch, caseId, caseLabel } = state.dataSel;
  const records = state.dataDraft.rows.filter((r) => !r._deleted).map(({ _new, _deleted, ...r }) => r);
  try {
    await request(`/api/data/table?level=${level}&table=${q(table)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ etag: state.dataView.etag, records }),
    });
    state.dataDraft = null;
    state.dataPicker = null;
    state.tree = await request('/api/tree');
    await loadData(level, true);
    await openData(level, table, { branch, caseId, caseLabel });
    toast('保存しました。版として残すには git でコミットしてください');
  } catch (err) {
    toast(err.message, true);
  }
}

// セルの入力欄。値のセルには「-」「NULL」「空文字」をワンクリックで入れるボタンを付ける
function openCellEditor(td) {
  if (td.classList.contains('editing')) return;
  const { rec, col } = td.dataset;
  const value = cellOf(dataRows().find((r) => r.id === rec), col);
  td.classList.add('editing');
  td.innerHTML = `<textarea class="cell-input" rows="${Math.max(1, value.split('\n').length)}">${esc(value)}</textarea>${
    col === PURPOSE
      ? ''
      : `<div class="cell-tools"><button type="button" data-set="-">-<span>任意</span></button><button type="button" data-set="NULL">NULL</button><button type="button" data-set="">""<span>空文字</span></button></div>`
  }`;
  const ta = td.querySelector('textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}
function commitCellEditor(td, value, cancel = false) {
  if (!td?.classList.contains('editing')) return;
  td.classList.remove('editing');
  const { rec, col } = td.dataset;
  if (!cancel && value !== cellOf(dataRows().find((r) => r.id === rec), col)) {
    ensureDataDraft();
    setCell(rec, col, value);
    settleDataDraft();
  }
  render();
}

function renderData() {
  const { level, table, branch, v, caseId, caseLabel } = state.dataSel;
  const t = state.dataView;
  if (!t) return '<div class="muted" style="padding:40px">テーブルが見つかりません</div>';
  const versions = state.dataVersionsBy[`${level}|${table}|${branch}`] ?? [];
  const isLatest = v === versions.at(-1)?.id;
  const isPast = !isLatest || (state.currentBranch && branch !== state.currentBranch);
  const editable = canEditData();
  const all = dataRows().map((r) => ({ ...r, refs: r.cases.map((ref, i) => ({ ...resolveRef(ref), i })), change: state.dataDraft ? recChange(r) : null }));
  const live = all.filter((r) => !r._deleted);
  const unused = live.filter((r) => !r.cases.length).length;
  const missing = live.reduce((n, r) => n + r.refs.filter((x) => x.missing).length, 0);
  const records = caseId ? all.filter((r) => r.refs.some((x) => x.id === caseId)) : all;

  const revertBtn = (r, col) =>
    `<button type="button" class="revert" data-act="data-revert-cell" data-rec="${esc(r.id)}" data-col="${esc(col)}" title="このセルの変更を戻す">↺</button>`;
  const isChanged = (r, col) => r.change?.type === 'changed' && r.change.cols.includes(col);
  const cellAttrs = (r, col, cls) => {
    const can = editable && !r._deleted;
    return `class="${cls} ${can ? 'ecell' : ''} ${isChanged(r, col) ? 'changed' : ''}" data-rec="${esc(r.id)}" data-col="${esc(col)}"`;
  };

  // 使用しているケースは API・画面ごとにまとめる。該当するケースがない番号は赤で出す。編集中は × で外せる
  const usageHtml = (r) => {
    const can = editable && !r._deleted;
    const x = (ref) => (can ? `<button type="button" class="ref-x" data-act="data-ref-remove" data-rec="${esc(r.id)}" data-index="${ref.i}" aria-label="外す">×</button>` : '');
    const groups = Map.groupBy(r.refs, (ref) => (ref.missing ? '' : ref.name));
    const list = [...groups]
      .map(([name, xs]) =>
        name
          ? `<div class="use"><span class="use-name">${esc(name)}</span>${xs
              .toSorted((a, b) => a.no - b.no)
              .map(
                (ref) => `<span class="use-chip"><button class="use-case ${ref.status === '無効' ? 'excluded' : ''} ${ref.id === caseId ? 'hit' : ''}" data-act="open-case" data-api="${esc(ref.api)}" data-level="${level}" data-id="${ref.id}" title="${esc(ref.title)}">#${ref.no}</button>${x(ref)}</span>`,
              )
              .join('')}</div>`
          : `<div class="use">${xs.map((ref) => `<span class="use-chip"><span class="use-missing" title="該当するケースがありません（${esc(ref.ref)}）">${esc(shortId(ref.ref))}</span>${x(ref)}</span>`).join('')}</div>`,
      )
      .join('');
    const empty = r.refs.length ? '' : '<span class="unused">未使用</span>';
    if (!can) return list || empty;
    const p = state.dataPicker;
    if (p?.rec === r.id) {
      const spec = t.catalog.find((s) => s.name === p.name) ?? t.catalog[0];
      return `${list}<div class="ref-picker">
        <select data-act="data-pick-name">${t.catalog.map((s) => `<option ${s === spec ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <select class="pick-no">${(spec?.cases ?? []).map((c) => `<option value="${c.id}">#${c.no} ${esc(c.title)}${c.status === '無効' ? '（無効）' : ''}</option>`).join('')}</select>
        <div class="pick-actions"><button type="button" class="btn small primary" data-act="data-pick-ok" data-rec="${esc(r.id)}">追加</button><button type="button" class="link" data-act="data-pick-cancel">キャンセル</button></div>
      </div>`;
    }
    return `${list || empty}<button type="button" class="ctl-add ref-add" data-act="data-ref-add" data-rec="${esc(r.id)}">+ ケース</button>`;
  };

  const rowActions = (r) => {
    if (!editable) return '';
    const btn = (act, label) => `<button type="button" class="link" data-act="${act}" data-id="${esc(r.id)}">${label}</button>`;
    if (r._deleted) return `<div class="row-actions">${btn('data-revert-rec', '削除を取り消す')}</div>`;
    return `<div class="row-actions">${btn('data-dup', '複製')}${btn('data-del', r._new ? '追加を取り消す' : '削除')}</div>`;
  };

  const rows = records
    .map(
      (r) => `<tr data-rec="${esc(r.id)}" class="${r.change ? `d-${r.change.type}` : ''}">
        <td class="idcell"><button class="uuid" data-act="copy-uuid" data-id="${esc(r.id)}" title="${esc(r.id)}（クリックでコピー）">${esc(r.id.slice(0, 8))}</button>${
          r.change ? `<span class="type ${r.change.type}">${DATA_TYPE_LABEL[r.change.type]}</span>` : ''
        }${rowActions(r)}</td>
        <td ${cellAttrs(r, PURPOSE, 'purpose')}>${r.purpose ? esc(r.purpose) : editable && !r._deleted ? '<span class="placeholder">（意図を入力）</span>' : ''}${isChanged(r, PURPOSE) ? revertBtn(r, PURPOSE) : ''}</td>
        <td class="usage ${isChanged(r, CASES) ? 'changed' : ''}">${usageHtml(r)}${isChanged(r, CASES) ? revertBtn(r, CASES) : ''}</td>
        ${t.columns.map((col) => `<td ${cellAttrs(r, col, 'mono val')}>${cellHtml(r.values[col] ?? '')}${isChanged(r, col) ? revertBtn(r, col) : ''}</td>`).join('')}
      </tr>`,
    )
    .join('');

  const warn = [
    missing ? `該当するケースがない紐付けが ${missing} 件あります（赤字）` : '',
  ].filter(Boolean);

  return `<div class="data-view ${editable ? 'can-edit' : ''}">
    <div class="specs-head">
      <div class="pane-head">
        <div class="crumb">テストデータ<span class="sep">/</span><span class="mono">${esc(table)}</span><span class="sep">/</span>${LABEL.level[level]}</div>
        ${branchSelect('data-branch', branch)}
        <select data-act="data-version">${versions
          .map((x) => `<option value="${x.id}" ${x.id === v ? 'selected' : ''}>${esc(x.label)}${x === versions.at(-1) ? ' · 最新' : ''}</option>`)
          .join('')}</select>
        <div class="spacer"></div>
        <button class="btn primary" data-act="data-add" ${editable ? '' : 'disabled'}>レコードを追加</button>
        ${state.branches.length ? dataModeSwitch() : ''}
      </div>
      ${isPast ? '<div class="note">選んだブランチ・版の時点の内容です。使用しているケースも、同じ時点のケースで表示しています。編集できるのは現在のブランチの最新だけです。</div>' : ''}
      ${warn.map((w) => `<div class="note warn">${w}</div>`).join('')}
      <div class="toolbar">
        <div class="summary">${live.length}件 · ${t.columns.length}カラム${unused ? ` · <span class="unused">未使用 ${unused}</span>` : ''}</div>
        ${caseId ? `<span class="data-filter">${esc(caseLabel)} で使うレコード（${records.length}件）<button class="link" data-act="clear-data-filter">解除</button></span>` : ''}
        <span class="legend"><span class="lg-title">セルの見方</span>
          <span class="lg"><code class="any">-</code>どんな値でもよい</span>
          <span class="lg"><code>NULL</code>NULL であること</span>
          <span class="lg"><code>""</code>空文字であること</span>
        </span>
      </div>
    </div>
    <div class="data-wrap" data-scroll="data">
      <table class="data-table">
        <thead><tr><th>id</th><th>意図</th><th>使用しているケース</th>${t.columns.map((col) => `<th class="mono">${esc(col)}</th>`).join('')}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${t.columns.length + 3}" class="muted">該当するレコードはありません</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- test data diff ---------- */

// レコードは id で照合する。cases 列は順番を問わない集合として比べる
function computeDataDiff(a, b) {
  const columns = [...new Set([...a.columns, ...b.columns])];
  const before = new Map(a.records.map((r) => [r.id, r]));
  const rows = b.records.map((r) => {
    const o = before.get(r.id);
    if (!o) return { type: 'added', rec: r };
    const purpose = o.purpose !== r.purpose ? o.purpose : null;
    const values = columns.filter((c) => (o.values[c] ?? '') !== (r.values[c] ?? '')).map((c) => ({ col: c, from: o.values[c], to: r.values[c] }));
    const added = r.cases.filter((x) => !o.cases.includes(x));
    const removed = o.cases.filter((x) => !r.cases.includes(x));
    const changed = purpose !== null || values.length || added.length || removed.length;
    return { type: changed ? 'changed' : 'same', rec: r, purpose, values, added, removed };
  });
  const ids = new Set(b.records.map((r) => r.id));
  rows.push(...a.records.filter((r) => !ids.has(r.id)).map((r) => ({ type: 'removed', rec: r })));
  return {
    rows,
    addedCols: b.columns.filter((c) => !a.columns.includes(c)),
    removedCols: a.columns.filter((c) => !b.columns.includes(c)),
  };
}

const DATA_TYPE_LABEL = { added: '追加', changed: '変更', removed: '削除', same: '変更なし' };
// 追加したケースは後の時点、外したケースは前の時点の番号で出す
const refTag = (ref, cls) => `<span class="ref-tag ${cls}">${cls === 'add' ? '+' : cls === 'del' ? '−' : ''} ${esc(refLabel(cls === 'del' ? state.dataDiff.a : state.dataDiff.b, ref))}</span>`;

function dataChangeHtml(row) {
  const r = row.rec;
  if (row.type === 'added') {
    const set = Object.entries(r.values).filter(([, v]) => v !== '-');
    return `<div class="dd-line"><span class="dd-k">値</span><span class="mono">${set.map(([k, v]) => `${esc(k)}=${cellHtml(v)}`).join('　')}</span></div>
      <div class="dd-line"><span class="dd-k">ケース</span><span>${r.cases.map((x) => refTag(x, 'add')).join('') || '<span class="muted">なし</span>'}</span></div>`;
  }
  if (row.type === 'removed') return `<span class="muted">このレコードは削除されました</span>`;
  if (row.type === 'same') return `<span class="muted">変更なし</span>`;
  return [
    ...row.values.map(
      (v) => `<div class="dd-line"><span class="dd-k mono">${esc(v.col)}</span><span class="inline-diff">
        ${v.from === undefined ? '' : `<span class="del mono">${cellHtml(v.from)}</span><span class="arrow">→</span>`}
        ${v.to === undefined ? '<span class="muted">（カラム削除）</span>' : `<span class="add mono">${cellHtml(v.to)}</span>`}</span></div>`,
    ),
    row.added.length || row.removed.length
      ? `<div class="dd-line"><span class="dd-k">ケース</span><span>${row.added.map((x) => refTag(x, 'add')).join('')}${row.removed.map((x) => refTag(x, 'del')).join('')}</span></div>`
      : '',
  ].join('');
}

function renderDataDiff() {
  const d = state.dataDiff;
  const { rows, addedCols, removedCols } = computeDataDiff(d.a, d.b);
  const n = (t) => rows.filter((r) => r.type === t).length;
  const shown = d.onlyChanged ? rows.filter((r) => r.type !== 'same') : rows;
  const options = (branch, cur) =>
    (state.dataVersionsBy[`${d.level}|${d.table}|${branch}`] ?? [])
      .map((v) => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.label)}</option>`)
      .join('');
  const colNote = [
    addedCols.length ? `カラムの追加：${addedCols.map(esc).join('、')}` : '',
    removedCols.length ? `カラムの削除：${removedCols.map(esc).join('、')}` : '',
  ].filter(Boolean);

  const body = shown
    .map(
      (row) => `<tr class="dd-${row.type}">
        <td><span class="type ${row.type}">${DATA_TYPE_LABEL[row.type]}</span></td>
        <td><button class="uuid" data-act="copy-uuid" data-id="${esc(row.rec.id)}" title="${esc(row.rec.id)}（クリックでコピー）">${esc(row.rec.id.slice(0, 8))}</button></td>
        <td class="purpose">${
          row.purpose !== null && row.purpose !== undefined
            ? `<span class="inline-diff"><span class="del">${esc(row.purpose)}</span><span class="arrow">→</span><span class="add">${esc(row.rec.purpose)}</span></span>`
            : esc(row.rec.purpose)
        }</td>
        <td class="dd-change">${dataChangeHtml(row)}</td>
      </tr>`,
    )
    .join('');

  return `<div class="data-view">
    <div class="diff-head">
      <div class="row"><div class="crumb">テストデータ<span class="sep">/</span><span class="mono">${esc(d.table)}</span><span class="sep">/</span>${LABEL.level[d.level]}</div><div class="spacer"></div>${dataModeSwitch()}</div>
      <div class="row">
        <label>比較元</label>${branchSelect('data-diff-from-branch', d.fromBranch)}<select data-act="data-diff-from">${options(d.fromBranch, d.from)}</select>
        <span class="arrow">→</span>
        <label>比較先</label>${branchSelect('data-diff-to-branch', d.toBranch)}<select data-act="data-diff-to">${options(d.toBranch, d.to)}</select>
      </div>
      <div class="row">
        <div class="summary">追加 ${n('added')} · 変更 ${n('changed')} · 削除 ${n('removed')} · 変更なし ${n('same')}</div>
        <label class="toggle"><input type="checkbox" data-act="data-only-changed" ${d.onlyChanged ? 'checked' : ''}>変更のあったレコードのみ表示</label>
      </div>
      ${colNote.map((t) => `<div class="note warn">${t}</div>`).join('')}
    </div>
    <div class="data-wrap" data-scroll="data-diff">
      <table class="data-table dd-table">
        <thead><tr><th>種別</th><th>id</th><th>意図</th><th>変更内容</th></tr></thead>
        <tbody>${body || '<tr><td colspan="4" class="muted">変更のあったレコードはありません</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- decision table ---------- */

// ディシジョンテーブルは API・画面に属するので、サイドバーではなく API のページの中でケースと切り替える
const levelEntry = () => state.tree.items.flatMap((t) => t.levels).find((l) => l.api === state.api && l.level === state.level);
const isDtView = () => state.view === 'dt' || state.view === 'dt-diff';
// API はディシジョンテーブル、画面（ui）はマトリクスを使う。ブランチ・版の選択、差分、下書き、保存の仕組みは共用する
const hasDt = () => true;
const isMx = () => specType(state.spec) === 'ui';
const tableWord = () => (isMx() ? 'マトリクス' : 'ディシジョンテーブル');
const paneTabs = () => {
  const l = levelEntry();
  const tab = (pane, label, n) =>
    `<button data-act="pane" data-pane="${pane}" class="${(pane === 'dt') === isDtView() ? 'on' : ''}">${label}<span>${n ?? 0}</span></button>`;
  return `<div class="pane-tabs">${tab('cases', 'ケース', l?.count)}${tab('dt', tableWord(), l?.dt)}</div>`;
};
const dtModeSwitch = () => {
  const b = (view, label) => `<button data-act="dt-mode" data-view-to="${view}" class="${state.view === view ? 'on' : ''}">${label}</button>`;
  return `<div class="seg mode-switch data-mode">${b('dt', '一覧')}${b('dt-diff', '差分')}</div>`;
};

const dtUrl = (branch, v) => `/api/dt?api=${q(state.api)}&level=${state.level}&branch=${q(branch)}${v ? `&v=${q(v)}` : ''}`;
async function dtVersionsOf(branch, force) {
  if (force || !state.dtVersionsBy[branch]) {
    state.dtVersionsBy[branch] = await request(`/api/dt/versions?api=${q(state.api)}&level=${state.level}&branch=${q(branch)}`);
  }
  return state.dtVersionsBy[branch];
}
// ケースの詳細に出すラベル用。現在のブランチの作業中の内容を使う
async function loadDtWorking() {
  state.dtWorking = await request(dtUrl(state.currentBranch));
}

// ブランチと版を選んで、その時点の表を表示する。focus を渡すと、そのルールの列を強調する
async function openDt({ branch, v, focus } = {}) {
  branch ??= state.branch;
  const versions = (await dtVersionsOf(branch, true)).map((x) => x.id);
  if (!versions.includes(v)) v = versions.at(-1);
  const data = v ? await request(dtUrl(branch, v)) : { tables: [], cases: [], missing: true };
  state.dt = { branch, v, ...data };
  if (!hasDtDirty()) state.dtDraft = null;
  state.dtFocus = focus ?? null;
  state.view = 'dt';
  render();
  if (focus) $(`.dt-table .focus[data-rule="${CSS.escape(focus.rule)}"]`)?.scrollIntoView({ block: 'center', inline: 'center' });
}

async function openDtDiff({ fromBranch, from, toBranch, to } = {}) {
  toBranch ??= state.dt?.branch ?? state.branch;
  fromBranch ??= toBranch;
  const toVs = (await dtVersionsOf(toBranch)).map((x) => x.id);
  const fromVs = (await dtVersionsOf(fromBranch)).map((x) => x.id);
  if (!toVs.includes(to)) to = toVs.at(-1);
  if (!fromVs.includes(from)) from = fromBranch === toBranch ? fromVs[Math.max(0, fromVs.indexOf(to) - 1)] : fromVs.at(-1);
  if (!from || !to) return toast(`このブランチには${tableWord()}がありません`, true);
  const [a, b] = await Promise.all([request(dtUrl(fromBranch, from)), request(dtUrl(toBranch, to))]);
  Object.assign(state.dtDiff, { fromBranch, from, toBranch, to, a, b });
  state.view = 'dt-diff';
  render();
}

const ruleLabel = (i) => `R${i + 1}`;
const condNames = (t) => (t.conditions ?? []).map((c) => c.name);
// 書かれていない条件は「どちらでもよい」として扱う
const whenOf = (r, name) => String(r.when?.[name] ?? '-');
const dtVal = (v) => (v === '-' ? '<span class="any" title="どちらでもよい">-</span>' : esc(v));
// 結果の行。actions にない結果が then に書かれていたら、行を足して表示する
const actionNames = (t) => [...new Set([...(t.actions ?? []), ...(t.rules ?? []).flatMap((r) => r.then ?? [])])];
const ruleState = (r) => (r.skip != null ? 'skip' : (r.cases ?? []).length ? 'ok' : 'none');

// ケースの詳細に出す、このケースを使っているルール
function dtRefs(c, compact) {
  if (isMx()) return mxRefs(c, compact);
  const refs = (state.dtWorking?.tables ?? []).flatMap((t) =>
    (t.rules ?? []).map((r, i) => ({ t, r, i })).filter(({ r }) => (r.cases ?? []).includes(c.id)),
  );
  const chips = refs
    .map(
      ({ t, r, i }) => `<button class="dref" data-act="open-dt-rule" data-table="${esc(t.id)}" data-rule="${esc(r.id)}" title="ディシジョンテーブルのこのルールを表示">
        <span class="k">${esc(t.name)}</span><span class="p">${ruleLabel(i)}</span></button>`,
    )
    .join('');
  if (compact) return refs.length ? `<div class="rdata"><span class="rlabel">ディシジョンテーブル</span><div class="chips">${chips}</div></div>` : '';
  return state.dtWorking?.tables.length ? `<h3>ディシジョンテーブル</h3><div class="ddata">${refs.length ? chips : '<span class="muted">なし</span>'}</div>` : '';
}

// 紐付けたケースのチップ。ファイルに書かれた順ではなく、ケースの番号順に並べる。rm には、外すボタンを作る関数を渡す
const caseChips = (ids, cases, rm) =>
  ids
    .map((id, i) => ({ id, i, c: cases.find((c) => c.id === id) }))
    .sort((a, b) => (a.c?.no ?? Infinity) - (b.c?.no ?? Infinity))
    .map(({ id, i, c }) => {
      const chip = c
        ? `<button class="use-case ${c.status === '無効' ? 'excluded' : ''}" data-act="open-case" data-api="${esc(state.api)}" data-level="${state.level}" data-id="${c.id}" title="${esc(c.title)}">#${c.no}</button>`
        : `<span class="use-missing" title="該当するケースがありません（${esc(id)}）">${esc(shortId(id))}</span>`;
      return `<span class="use-chip">${chip}${rm(i)}</span>`;
    })
    .join('');

// 表の下に出す、ケース名との対応の一覧。ケースが多いと長くなるので、開いたときだけ出す
function caseListHtml(tableId, title, items, cases, wide = false) {
  if (!items.length) return '';
  const open = state.dtListOpen.has(tableId);
  const count = items.reduce((sum, x) => sum + x.ids.length, 0);
  const line = (id) => {
    const c = cases.find((x) => x.id === id);
    return c
      ? `<button type="button" class="dt-list-case ${c.status === '無効' ? 'excluded' : ''}" data-act="open-case" data-api="${esc(state.api)}" data-level="${state.level}" data-id="${c.id}"><span class="mono">#${c.no}</span>${esc(c.title)}</button>`
      : `<span class="dt-list-case"><span class="use-missing">${esc(shortId(id))}</span>該当するケースがありません</span>`;
  };
  const noOf = (id) => cases.find((c) => c.id === id)?.no ?? Infinity;
  return `<div class="dt-list ${wide ? 'wide' : ''}"><button type="button" class="link dt-list-toggle" data-act="dt-list-toggle" data-table="${esc(tableId)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${title}（ケース ${count}）</button>${
    !open
      ? ''
      : `<ul>${items
          .map(
            (x) => `<li><span class="mono dt-list-rule">${esc(x.label)}</span><span class="dt-list-cases">${
              x.ids.length ? x.ids.toSorted((a, b) => noOf(a) - noOf(b)).map(line).join('') : '<span class="dt-none">ケースなし</span>'
            }</span></li>`,
          )
          .join('')}</ul>`
  }</div>`;
}

/* ---------- matrix ---------- */

// 画面（ui）用。行が確認する項目、列が条件で、確認するマスに ○ を付けてケースを紐付ける。○ のないマスは確認しない
// ファイルは matrices/<level>/<画面>.yaml。cells に書かれているマスが ○ にあたる
const toMxModel = (tables) =>
  tables.map((t) => ({
    ...t,
    rows: (t.rows ?? []).map((x) => ({ name: String(x), _orig: String(x) })),
    cols: (t.cols ?? []).map((x) => ({ name: String(x), _orig: String(x) })),
    cells: (t.cells ?? []).map((c) => ({ ...c, row: String(c.row), col: String(c.col), cases: [...(c.cases ?? [])] })),
  }));
const mxCell = (t, row, col) => (t.cells ?? []).find((c) => String(c.row) === row && String(c.col) === col);
const mxKey = (row, col) => `${row}\t${col}`;
// 行・列にあるマスだけを、行→列の順に並べる
const mxMarks = (t) => t.rows.flatMap((r) => t.cols.map((c) => mxCell(t, r.name, c.name)).filter(Boolean));

// マスの変更。行・列の名前を変えていても、保存済みの名前で元のマスと比べる
function mxCellChanged(t, r, c) {
  if (t._new) return false;
  const o = r._orig && c._orig ? mxCell(origDtTable(t.id), r._orig, c._orig) : undefined;
  const d = mxCell(t, r.name, c.name);
  return !!o !== !!d || (!!d && d.cases.join() !== (o.cases ?? []).join());
}
function mxTableChange(t) {
  if (t._new) return { type: 'added', what: ['新規追加'] };
  if (t._deleted) return { type: 'removed', what: ['削除'] };
  const o = origDtTable(t.id);
  const what = [];
  const names = (list) => list.map((x) => x.name ?? String(x)).join('\n');
  if (t.name !== o.name) what.push('名前');
  if ((t.description ?? '') !== (o.description ?? '')) what.push('説明');
  if (names(t.rows) !== names(o.rows ?? [])) what.push('行');
  if (names(t.cols) !== names(o.cols ?? [])) what.push('列');
  const n = t.rows.reduce((sum, r) => sum + t.cols.filter((c) => mxCellChanged(t, r, c)).length, 0);
  if (n) what.push(`マス ${n}`);
  return what.length ? { type: 'changed', what } : null;
}
// 保存する形に戻す。変更していない表は元の書き方のまま残す。変更した表のマスは、行→列の順に書く
function mxPayload() {
  return state.dtDraft.tables
    .filter((t) => !t._deleted)
    .map((t) => {
      const o = origDtTable(t.id);
      if (o && !mxTableChange(t)) return o;
      const { _new, _deleted, id, name, description, rows, cols, cells, ...rest } = t;
      return {
        id,
        name,
        ...(description ? { description } : {}),
        ...rest,
        rows: rows.map((r) => r.name),
        cols: cols.map((c) => c.name),
        cells: mxMarks(t).map(({ row, col, cases, ...extra }) => ({ row, col, ...extra, cases })),
      };
    });
}

// ケースの詳細に出す、このケースを紐付けているマス
function mxRefs(c, compact) {
  const tables = state.dtWorking?.tables ?? [];
  const refs = tables.flatMap((t) => (t.cells ?? []).filter((x) => (x.cases ?? []).includes(c.id)).map((x) => ({ t, x })));
  const chips = refs
    .map(
      ({ t, x }) => `<button class="dref" data-act="open-dt-rule" data-table="${esc(t.id)}" data-rule="${esc(mxKey(x.row, x.col))}" title="マトリクスのこのマスを表示">
        <span class="k">${esc(t.name)}</span><span class="p">${esc(x.row)} × ${esc(x.col)}</span></button>`,
    )
    .join('');
  if (compact) return refs.length ? `<div class="rdata"><span class="rlabel">マトリクス</span><div class="chips">${chips}</div></div>` : '';
  return tables.length ? `<h3>マトリクス</h3><div class="ddata">${refs.length ? chips : '<span class="muted">なし</span>'}</div>` : '';
}

function mxTableHtml(t, cases, editable) {
  const tid = esc(t.id);
  const change = state.dtDraft ? mxTableChange(t) : null;
  if (t._deleted) {
    return `<section class="dt dt-deleted" data-dt="${tid}"><div class="dt-head"><span class="type removed">削除</span><h2>${esc(t.name)}</h2>
      <button class="link" data-act="dt-table-revert" data-table="${tid}">削除を取り消す</button></div></section>`;
  }
  const focus = state.dtFocus?.table === t.id ? state.dtFocus.rule : null;
  const marks = mxMarks(t);
  const none = marks.filter((c) => !c.cases.length).length;
  const stray = t.cells.length - marks.length;
  const edit = (kind, i) => (editable ? `class="dt-editable" data-dtedit="${kind}" data-table="${tid}" ${i == null ? '' : `data-index="${i}"`} title="クリックして編集"` : '');
  const mv = (kind, i, dir, label, title) =>
    `<button type="button" class="link" data-act="mx-move" data-kind="${kind}" data-table="${tid}" data-index="${i}" data-dir="${dir}" title="${title}" aria-label="${title}">${label}</button>`;
  const isNew = (x) => state.dtDraft && !t._new && x._orig !== x.name;

  const head = t.cols
    .map((c, j) => {
      const move = editable && t.cols.length > 1 ? `<span class="dt-rule-actions">${j > 0 ? mv('mxcol', j, -1, '←', '左へ移動') : ''}${j < t.cols.length - 1 ? mv('mxcol', j, 1, '→', '右へ移動') : ''}</span>` : '';
      return `<th ${edit('mxcol', j)} ${isNew(c) ? 'data-changed' : ''}>${esc(c.name)}${move}</th>`;
    })
    .join('');

  const cell = (r, i, c, j) => {
    const x = mxCell(t, r.name, c.name);
    const key = mxKey(r.name, c.name);
    const pos = `data-table="${tid}" data-row="${i}" data-col="${j}"`;
    const cls = `mx-cell ${state.dtDraft && mxCellChanged(t, r, c) ? 'cell-changed' : ''} ${key === focus ? 'focus' : ''}`;
    if (!x) return editable ? `<td class="${cls} mx-off" data-act="mx-on" ${pos} title="クリックして ○ を付ける"></td>` : `<td class="${cls}"></td>`;
    const rm = (i2) => (editable ? `<button type="button" class="ref-x" data-act="mx-case-remove" data-index="${i2}" aria-label="外す">×</button>` : '');
    const tools = editable
      ? `<div class="dt-case-tools"><button type="button" class="link" data-act="dt-case-add">+ ケース</button><button type="button" class="link" data-act="mx-off" data-table="${tid}">○ を外す</button></div>`
      : '';
    return `<td class="${cls}" data-rule="${esc(key)}" ${pos}><span class="mx-mark">○</span>${caseChips(x.cases, cases, rm)}${
      x.cases.length ? '' : '<span class="dt-none">ケースなし</span>'
    }${tools}</td>`;
  };
  const body = t.rows
    .map((r, i) => {
      const move = editable && t.rows.length > 1 ? `<span class="dt-row-move">${i > 0 ? mv('mxrow', i, -1, '↑', '上へ移動') : ''}${i < t.rows.length - 1 ? mv('mxrow', i, 1, '↓', '下へ移動') : ''}</span>` : '';
      return `<tr><th ${edit('mxrow', i)} ${isNew(r) ? 'data-changed' : ''}>${esc(r.name)}${move}</th>${t.cols.map((c, j) => cell(r, i, c, j)).join('')}${editable ? '<td class="dt-fill"></td>' : ''}</tr>`;
    })
    .join('');
  const span = t.cols.length + 1 + (editable ? 1 : 0);
  const caseList = caseListHtml(t.id, 'マスとケースの対応', marks.map((x) => ({ label: `${x.row} × ${x.col}`, ids: x.cases })), cases, true);

  return `<section class="dt ${change ? `dt-t-${change.type}` : ''}" data-dt="${tid}">
    <div class="dt-head">${change ? `<span class="type ${change.type}">${DATA_TYPE_LABEL[change.type]}</span>` : ''}<h2 ${edit('tname')}>${esc(t.name)}</h2>
      <span class="summary">確認するマス ${marks.length}${none ? ` · <span class="dt-none">ケースなし ${none}</span>` : ''}${stray ? ` · <span class="dt-none">行・列にないマス ${stray}</span>` : ''}</span>
      ${editable ? `<span class="dt-table-actions">${change?.type === 'changed' ? `<button class="link" data-act="dt-table-revert" data-table="${tid}">この表の変更を戻す</button>` : ''}<button class="link" data-act="dt-table-del" data-table="${tid}">${t._new ? '追加を取り消す' : '表を削除'}</button></span>` : ''}</div>
    ${t.description || editable ? `<p class="dt-desc"><span ${edit('tdesc')}>${t.description ? esc(t.description) : '<span class="placeholder">（説明を入力）</span>'}</span></p>` : ''}
    <div class="dt-scroll"><table class="dt-table mx-table ${editable ? 'can-edit' : ''}">
      <thead><tr><th class="dt-corner"></th>${head}${editable ? `<th class="dt-fill"><button type="button" class="link" data-act="mx-col-add" data-table="${tid}">+ 列</button></th>` : ''}</tr></thead>
      <tbody>${body}${editable ? `<tr class="dt-add"><th colspan="${span}"><button type="button" class="link" data-act="mx-row-add" data-table="${tid}">+ 行</button></th></tr>` : ''}</tbody>
    </table></div>
    ${caseList}
  </section>`;
}

// 表は id、行・列は名前で照合する
function diffMxTable(o, n) {
  const t = n ?? o;
  const lines = (key) => {
    const an = o ? (o[key] ?? []).map(String) : [];
    const bn = n ? (n[key] ?? []).map(String) : [];
    return [...bn.map((name) => ({ name, type: !o || an.includes(name) ? 'same' : 'added' })), ...(n ? an.filter((x) => !bn.includes(x)).map((name) => ({ name, type: 'removed' })) : [])];
  };
  const rows = lines('rows');
  const cols = lines('cols');
  const cells = rows.map((r) =>
    cols.map((c) => {
      const was = o && mxCell(o, r.name, c.name);
      const now = n && mxCell(n, r.name, c.name);
      const type = !o || !n || (!was && !now) ? 'same' : !was ? 'added' : !now ? 'removed' : (was.cases ?? []).join() !== (now.cases ?? []).join() ? 'changed' : 'same';
      return { was, now, type };
    }),
  );
  const nameFrom = o && n && o.name !== n.name ? o.name : null;
  const changed = nameFrom !== null || [...rows, ...cols, ...cells.flat()].some((x) => x.type !== 'same');
  return { type: !o ? 'added' : !n ? 'removed' : changed ? 'changed' : 'same', t, nameFrom, rows, cols, cells };
}

function mxDiffTableHtml(d) {
  const { t } = d;
  const { a, b } = state.dtDiff;
  const cls = (x) => (x.type === 'same' ? '' : `dt-${x.type}`);
  const th = (x) => `<th class="${cls(x)}">${esc(x.name)}${x.type === 'same' ? '' : `<span class="type ${x.type}">${DATA_TYPE_LABEL[x.type]}</span>`}</th>`;
  // 番号はその時点の並び順で決まるので、外したケースは前の時点、それ以外は後の時点の番号で出す
  const label = (side, id) => {
    const c = side.cases.find((y) => y.id === id);
    return c ? `<span title="${esc(c.title)}">#${c.no}</span>` : esc(shortId(id));
  };
  const cell = (x) => {
    const cur = x.now ?? x.was;
    if (!cur) return '';
    const now = x.now?.cases ?? [];
    const was = x.was?.cases ?? [];
    const mark = x.type === 'added' ? '<span class="ref-tag add">+ ○</span>' : x.type === 'removed' ? '<span class="ref-tag del">− ○</span>' : '<span class="mx-mark">○</span>';
    const tags = [
      ...now.map((id) => (!x.was || was.includes(id) ? `<span class="ref-tag">${label(b, id)}</span>` : `<span class="ref-tag add">+ ${label(b, id)}</span>`)),
      ...(x.now ? was.filter((id) => !now.includes(id)) : was).map((id) => `<span class="ref-tag ${x.now ? 'del' : ''}">${x.now ? '− ' : ''}${label(a, id)}</span>`),
    ];
    return `${mark}${tags.join('')}${x.now && !now.length ? '<span class="dt-none">ケースなし</span>' : ''}`;
  };
  return `<section class="dt dt-t-${d.type}">
    <div class="dt-head"><span class="type ${d.type}">${DATA_TYPE_LABEL[d.type]}</span>
      <h2>${d.nameFrom !== null ? oldNew(esc(d.nameFrom), esc(t.name)) : esc(t.name)}</h2></div>
    <div class="dt-scroll"><table class="dt-table mx-table">
      <thead><tr><th class="dt-corner"></th>${d.cols.map(th).join('')}</tr></thead>
      <tbody>${d.rows
        .map((r, i) => `<tr class="${cls(r)}">${th(r)}${d.cols.map((c, j) => `<td class="mx-cell ${cls(c)} ${d.cells[i][j].type === 'changed' ? 'dt-changed' : ''}">${cell(d.cells[i][j])}</td>`).join('')}</tr>`)
        .join('')}</tbody>
    </table></div>
  </section>`;
}

/* ---------- decision table editing ---------- */

// 表示と編集で同じ形を使う。条件・結果には、保存済みの名前（_orig）を持たせて名前の変更を追えるようにする
// 編集中は、追加した表・ルールに _new、削除したものに _deleted を付ける。保存するまでファイルには書き込まない
const toDtModel = (tables) => (isMx() ? toMxModel(tables) : toRuleModel(tables));
const toRuleModel = (tables) =>
  tables.map((t) => ({
    ...t,
    conditions: (t.conditions ?? []).map((c) => ({ name: c.name, values: [...(c.values ?? [])].map(String), _orig: c.name })),
    actions: actionNames(t).map((a) => ({ name: a, _orig: a })),
    rules: (t.rules ?? []).map((r) => ({ ...r, when: { ...r.when }, then: [...(r.then ?? [])], cases: [...(r.cases ?? [])] })),
  }));
const canEditDt = () => !!state.dt?.etag;
const dtTables = () => state.dtDraft?.tables ?? toDtModel(state.dt.tables);
const origDtTable = (id) => state.dt.tables.find((t) => t.id === id);
const draftTable = (id) => state.dtDraft.tables.find((t) => t.id === id);
function ensureDtDraft() {
  state.dtDraft ??= { tables: toDtModel(state.dt.tables) };
  return state.dtDraft;
}
function settleDtDraft() {
  if (state.dtDraft && !state.dtDraft.tables.some(dtTableChange)) state.dtDraft = null;
}
const hasDtDirty = () => !!state.dtDraft && state.dtDraft.tables.some(dtTableChange);

// ルールの変更。条件・結果の名前を変えていても、保存済みの名前で元の値と比べる
function dtRuleChange(t, r) {
  if (t._new) return null;
  if (r._new) return { type: 'added' };
  if (r._deleted) return { type: 'removed' };
  const o = origDtTable(t.id).rules.find((x) => x.id === r.id);
  const conds = t.conditions.filter((c) => whenOf(r, c.name) !== (c._orig ? whenOf(o, c._orig) : '-')).map((c) => c.name);
  const actions = t.actions.filter((a) => r.then.includes(a.name) !== (a._orig ? (o.then ?? []).includes(a._orig) : false)).map((a) => a.name);
  const cases = r.cases.join() !== (o.cases ?? []).join() || (r.skip ?? null) !== (o.skip ?? null);
  return conds.length || actions.length || cases ? { type: 'changed', conds, actions, cases } : null;
}
const plainConds = (list) => JSON.stringify((list ?? []).map((c) => [c.name, (c.values ?? []).map(String)]));
function dtTableChange(t) {
  if (isMx()) return mxTableChange(t);
  if (t._new) return { type: 'added', what: ['新規追加'] };
  if (t._deleted) return { type: 'removed', what: ['削除'] };
  const o = origDtTable(t.id);
  const what = [];
  if (t.name !== o.name) what.push('名前');
  if ((t.description ?? '') !== (o.description ?? '')) what.push('説明');
  if (plainConds(t.conditions) !== plainConds(o.conditions)) what.push('条件');
  if (t.actions.map((a) => a.name).join('\n') !== actionNames(o).join('\n')) what.push('結果');
  t.rules.forEach((r, i) => dtRuleChange(t, r) && what.push(ruleLabel(i)));
  const kept = t.rules.filter((r) => !r._new).map((r) => r.id);
  if (kept.join() !== o.rules.map((r) => r.id).join()) what.push('ルールの並び順');
  return what.length ? { type: 'changed', what } : null;
}

// 保存する形に戻す。変更していない表・ルールは元の書き方のまま残して、余計な差分を出さない
function dtPayload() {
  if (isMx()) return mxPayload();
  return state.dtDraft.tables
    .filter((t) => !t._deleted)
    .map((t) => {
      const o = origDtTable(t.id);
      if (o && !dtTableChange(t)) return o;
      const sameConds = o && t.conditions.map((c) => c.name).join('\n') === condNames(o).join('\n') && t.actions.every((a) => a._orig === a.name);
      // キーの並びを元のファイルと同じにして、余計な差分を出さない
      const { _new, _deleted, id, name, description, conditions, actions, rules, ...rest } = t;
      return {
        id,
        name,
        ...(description ? { description } : {}),
        ...rest,
        conditions: t.conditions.map(({ name, values }) => ({ name, values })),
        actions: t.actions.map((a) => a.name),
        rules: t.rules
          .filter((r) => !r._deleted)
          .map((r) => {
            const orig = o?.rules.find((x) => x.id === r.id);
            if (orig && sameConds && !dtRuleChange(t, r)) return orig;
            const { _new: n, _deleted: d, when, then, cases, skip, ...extra } = r;
            return {
              ...extra,
              when: Object.fromEntries(t.conditions.map((c) => [c.name, whenOf(r, c.name)])),
              then: t.actions.map((a) => a.name).filter((a) => then.includes(a)),
              ...(skip != null ? { skip } : { cases }),
            };
          }),
      };
    });
}

async function saveDtDraft() {
  const tables = state.dtDraft.tables.filter((t) => !t._deleted);
  const noName = tables.find((t) => !t.name.trim());
  if (noName) return toast('表の名前を入力してください', true);
  for (const t of tables) {
    const i = (t.rules ?? []).findIndex((r) => !r._deleted && r.skip != null && !r.skip.trim());
    if (i >= 0) return toast(`「${t.name}」の ${ruleLabel(i)} の対象外の理由を入力してください`, true);
  }
  try {
    await request(`/api/dt?api=${q(state.api)}&level=${state.level}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ etag: state.dt.etag, tables: dtPayload() }),
    });
    state.dtDraft = null;
    state.tree = await request('/api/tree');
    await loadDtWorking();
    await openDt({ branch: state.dt.branch });
    toast('保存しました。版として残すには git でコミットしてください');
  } catch (err) {
    toast(err.message, true);
  }
}

// 条件・結果の名前を変えたら、ルール側の書き方も合わせて変える
function renameCond(t, c, name) {
  for (const r of t.rules) {
    if (c.name in r.when) (r.when[name] = r.when[c.name]), delete r.when[c.name];
  }
  c.name = name;
}
function renameAction(t, a, name) {
  for (const r of t.rules) r.then = r.then.map((x) => (x === a.name ? name : x));
  a.name = name;
}
function revertDtRule(t, r) {
  const i = t.rules.indexOf(r);
  if (r._new) return t.rules.splice(i, 1);
  const o = origDtTable(t.id).rules.find((x) => x.id === r.id);
  // 条件・結果の名前を変えていたら、今の名前に合わせて戻す
  t.rules[i] = {
    ...o,
    when: Object.fromEntries(t.conditions.filter((c) => c._orig).map((c) => [c.name, whenOf(o, c._orig)])),
    then: t.actions.filter((a) => a._orig && (o.then ?? []).includes(a._orig)).map((a) => a.name),
    cases: [...(o.cases ?? [])],
  };
}
const newDtRule = (t, base) => ({
  ...(base ? structuredClone(base) : { when: Object.fromEntries(t.conditions.map((c) => [c.name, '-'])), then: [], cases: [] }),
  id: crypto.randomUUID(),
  _new: true,
  _deleted: undefined,
});

// 名前・説明・対象外の理由・条件・結果の入力欄。条件は「名前」と「取りうる値（カンマ区切り）」の 2 つ
function openDtEditor(el) {
  if (el.querySelector('.dt-input')) return;
  const { dtedit: kind, table, index, rule } = el.dataset;
  const t = dtTables().find((x) => x.id === table);
  const input = (name, value, ph) => `<input class="dt-input" name="${name}" value="${esc(value)}" placeholder="${ph}">`;
  let html;
  if (kind === 'tname') html = input('value', t.name, '表の名前');
  else if (kind === 'tdesc') html = input('value', t.description ?? '', '表の説明');
  else if (kind === 'skip') html = input('value', t.rules.find((r) => r.id === rule).skip ?? '', 'テストしない理由');
  else if (kind === 'action') html = input('value', t.actions[index].name, '結果（例：400を返す）');
  else if (kind === 'mxrow') html = input('value', t.rows[index].name, '行（例：メールアドレス）');
  else if (kind === 'mxcol') html = input('value', t.cols[index].name, '列（例：未入力）');
  else html = input('value', t.conditions[index].name, '条件（例：名前）') + input('values', t.conditions[index].values.join(', '), '値をカンマ区切りで（例：あり, 空）');
  const del = ['cond', 'action', 'mxrow', 'mxcol'].includes(kind) ? `<button type="button" class="link" data-act="dt-row-del" data-kind="${kind}" data-table="${esc(table)}" data-index="${index}">削除</button>` : '';
  el.classList.add('editing');
  el.innerHTML = `<span class="dt-editor">${html}${del}</span>`;
  const first = el.querySelector('.dt-input');
  first.focus();
  first.select();
}
function commitDtEditor(el, cancel = false) {
  if (!el?.querySelector('.dt-input')) return;
  const { dtedit: kind, table, index, rule } = el.dataset;
  const value = el.querySelector('[name="value"]').value.trim();
  const values = el.querySelector('[name="values"]')?.value.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
  el.innerHTML = '';
  if (!cancel) {
    const t = ensureDtDraft().tables.find((x) => x.id === table);
    if (kind === 'tname') t.name = value || t.name;
    else if (kind === 'tdesc') t.description = value;
    else if (kind === 'skip') t.rules.find((r) => r.id === rule).skip = value;
    else if (kind === 'mxrow' || kind === 'mxcol') {
      // 行・列の名前を変えたら、マス側の書き方も合わせて変える
      const [list, key] = kind === 'mxrow' ? [t.rows, 'row'] : [t.cols, 'col'];
      const item = list[index];
      if (list.some((x) => x !== item && x.name === value)) toast(`「${value}」はすでにあります`, true);
      else if (value && value !== item.name) {
        for (const c of t.cells) if (c[key] === item.name) c[key] = value;
        item.name = value;
      }
    } else {
      const list = kind === 'cond' ? t.conditions : t.actions;
      const row = list[index];
      if (list.some((x) => x !== row && x.name === value)) toast(`「${value}」はすでにあります`, true);
      else if (value && value !== row.name) (kind === 'cond' ? renameCond : renameAction)(t, row, value);
      if (kind === 'cond') row.values = [...new Set(values)];
    }
  }
  // 名前を入れずに閉じた行は残さない
  for (const t of state.dtDraft?.tables ?? []) {
    for (const key of ['conditions', 'actions', 'rows', 'cols']) if (t[key]) t[key] = t[key].filter((x) => x.name);
  }
  settleDtDraft();
  render();
}

// 条件の値とケースは、ブラウザ標準の選択欄で選ぶ（表の外にはみ出しても隠れない）
function openDtSelect(td, html) {
  td.innerHTML = html;
  const sel = td.querySelector('select');
  sel.focus();
  try {
    sel.showPicker();
  } catch {}
}

function dtTableHtml(t, cases, editable) {
  const tid = esc(t.id);
  const change = state.dtDraft ? dtTableChange(t) : null;
  const rules = t.rules.map((r, i) => ({ r, i, change: state.dtDraft ? dtRuleChange(t, r) : null }));
  const focus = state.dtFocus?.table === t.id ? state.dtFocus.rule : null;
  if (t._deleted) {
    return `<section class="dt dt-deleted" data-dt="${tid}"><div class="dt-head"><span class="type removed">削除</span><h2>${esc(t.name)}</h2>
      <button class="link" data-act="dt-table-revert" data-table="${tid}">削除を取り消す</button></div></section>`;
  }
  const colCls = ({ r, change: c }) => `${r.id === focus ? 'focus' : ''} ${c ? `dt-${c.type}` : ''}`;
  const can = (x) => editable && !x.r._deleted;
  const span = rules.length + 1 + (editable ? 1 : 0);
  const filler = editable ? '<td class="dt-fill"></td>' : '';
  const attrs = (x) => `data-table="${tid}" data-rule="${esc(x.r.id)}"`;

  const head = rules
    .map((x) => {
      const c = x.change;
      const btn = (act, label, title = '') => `<button type="button" class="link" data-act="${act}" ${attrs(x)} ${title ? `title="${title}" aria-label="${title}"` : ''}>${label}</button>`;
      const actions = !editable
        ? ''
        : x.r._deleted
          ? btn('dt-rule-revert', '取り消す')
          : `${x.i > 0 ? btn('dt-rule-left', '←', '左へ移動') : ''}${x.i < rules.length - 1 ? btn('dt-rule-right', '→', '右へ移動') : ''}${btn('dt-rule-dup', '複製')}${btn('dt-rule-del', x.r._new ? '取り消す' : '削除')}${c?.type === 'changed' ? btn('dt-rule-revert', '戻す') : ''}`;
      return `<th class="${colCls(x)}" data-rule="${esc(x.r.id)}">${ruleLabel(x.i)}${c ? `<span class="type ${c.type}">${DATA_TYPE_LABEL[c.type]}</span>` : ''}${
        actions ? `<span class="dt-rule-actions">${actions}</span>` : ''
      }</th>`;
    })
    .join('');

  const rowTh = (kind, row, i) => {
    const changed = state.dtDraft && !t._new && (!row._orig || row._orig !== row.name || (kind === 'cond' && plainConds([row]) !== plainConds(origDtTable(t.id).conditions.filter((c) => c.name === row._orig))));
    const vals = kind === 'cond' && row.values.length ? `<span class="dt-values">${row.values.map(esc).join(' / ')}</span>` : '';
    const len = (kind === 'cond' ? t.conditions : t.actions).length;
    const mv = (dir, label, title) => `<button type="button" class="link" data-act="dt-row-move" data-kind="${kind}" data-table="${tid}" data-index="${i}" data-dir="${dir}" title="${title}" aria-label="${title}">${label}</button>`;
    const move = editable && len > 1 ? `<span class="dt-row-move">${i > 0 ? mv(-1, '↑', '上へ移動') : ''}${i < len - 1 ? mv(1, '↓', '下へ移動') : ''}</span>` : '';
    return `<th class="${editable ? 'dt-editable' : ''} ${changed ? 'dt-changed' : ''}" ${editable ? `data-dtedit="${kind}" data-table="${tid}" data-index="${i}" title="クリックして編集"` : ''}>${esc(row.name)}${vals}${move}</th>`;
  };

  const condRows = t.conditions
    .map(
      (c, i) => `<tr>${rowTh('cond', c, i)}${rules
        .map((x) => {
          const v = whenOf(x.r, c.name);
          const chg = x.change?.type === 'changed' && x.change.conds.includes(c.name);
          const odd = v !== '-' && c.values.length && !c.values.includes(v);
          return `<td class="${colCls(x)} ${chg ? 'cell-changed' : ''} ${can(x) ? 'dt-cell' : ''}" ${can(x) ? `data-kind="cond" data-cond="${i}" ${attrs(x)}` : ''}>${
            odd ? `<span class="use-missing" title="条件の値の一覧にありません">${esc(v)}</span>` : dtVal(v)
          }</td>`;
        })
        .join('')}${filler}</tr>`,
    )
    .join('');

  const actionRows = t.actions
    .map(
      (a, i) => `<tr>${rowTh('action', a, i)}${rules
        .map((x) => {
          const chg = x.change?.type === 'changed' && x.change.actions.includes(a.name);
          return `<td class="${colCls(x)} ${chg ? 'cell-changed' : ''} ${can(x) ? 'dt-cell' : ''}" ${can(x) ? `data-kind="action" data-action="${i}" ${attrs(x)}` : ''}>${
            x.r.then.includes(a.name) ? '<span class="dt-check">✓</span>' : ''
          }</td>`;
        })
        .join('')}${filler}</tr>`,
    )
    .join('');

  const caseCell = (x) => {
    const { r } = x;
    const e = can(x);
    const rm = (act, extra = '') => (e ? `<button type="button" class="ref-x" data-act="${act}" ${attrs(x)} ${extra} aria-label="外す">×</button>` : '');
    if (r.skip != null) return `<span class="use-chip"><span class="dt-skip">対象外</span>${rm('dt-skip-off')}</span>`;
    const chips = caseChips(r.cases, cases, (i) => rm('dt-case-remove', `data-index="${i}"`));
    const none = r.cases.length ? '' : '<span class="dt-none">ケースなし</span>';
    const tools = e
      ? `<div class="dt-case-tools"><button type="button" class="link" data-act="dt-case-add" ${attrs(x)}>+ ケース</button>${
          r.cases.length ? '' : `<button type="button" class="link" data-act="dt-skip-on" ${attrs(x)}>対象外にする</button>`
        }</div>`
      : '';
    return `${chips}${none}${tools}`;
  };
  const caseRow = rules
    .map((x) => `<td class="${colCls(x)} ${x.change?.type === 'changed' && x.change.cases ? 'cell-changed' : ''}" ${attrs(x)}>${caseCell(x)}</td>`)
    .join('');

  const live = t.rules.filter((r) => !r._deleted);
  const n = (st) => live.filter((r) => ruleState(r) === st).length;
  const skips = rules.filter((x) => !x.r._deleted && x.r.skip != null);
  const caseList = caseListHtml(t.id, 'ルールとケースの対応', rules.filter((x) => !x.r._deleted && x.r.skip == null).map((x) => ({ label: ruleLabel(x.i), ids: x.r.cases })), cases);
  const addRow = (act, label) => (editable ? `<tr class="dt-add"><th colspan="${span}"><button type="button" class="link" data-act="${act}" data-table="${tid}">${label}</button></th></tr>` : '');
  const edit = (kind) => (editable ? `class="dt-editable" data-dtedit="${kind}" data-table="${tid}" title="クリックして編集"` : '');

  return `<section class="dt ${change ? `dt-t-${change.type}` : ''}" data-dt="${tid}">
    <div class="dt-head">${change ? `<span class="type ${change.type}">${DATA_TYPE_LABEL[change.type]}</span>` : ''}<h2 ${edit('tname')}>${esc(t.name)}</h2>
      <span class="summary">ルール ${live.length}${n('none') ? ` · <span class="dt-none">ケースなし ${n('none')}</span>` : ''}${n('skip') ? ` · 対象外 ${n('skip')}` : ''}</span>
      ${editable ? `<span class="dt-table-actions">${change?.type === 'changed' ? `<button class="link" data-act="dt-table-revert" data-table="${tid}">この表の変更を戻す</button>` : ''}<button class="link" data-act="dt-table-del" data-table="${tid}">${t._new ? '追加を取り消す' : '表を削除'}</button></span>` : ''}</div>
    ${t.description || editable ? `<p class="dt-desc"><span ${edit('tdesc')}>${t.description ? esc(t.description) : '<span class="placeholder">（説明を入力）</span>'}</span></p>` : ''}
    <div class="dt-scroll"><table class="dt-table ${editable ? 'can-edit' : ''}">
      <thead><tr><th class="dt-corner"></th>${head}${editable ? `<th class="dt-fill"><button type="button" class="link" data-act="dt-rule-add" data-table="${tid}">+ ルール</button></th>` : ''}</tr></thead>
      <tbody>
        <tr class="dt-sec"><th colspan="${span}">条件</th></tr>
        ${condRows}${addRow('dt-cond-add', '+ 条件')}
        <tr class="dt-sec"><th colspan="${span}">結果</th></tr>
        ${actionRows}${addRow('dt-action-add', '+ 結果')}
        <tr class="dt-sec"><th colspan="${span}">テスト</th></tr>
        <tr class="dt-cases"><th>ケース</th>${caseRow}${filler}</tr>
      </tbody>
    </table></div>
    ${caseList}
    ${
      skips.length
        ? `<ul class="dt-notes">${skips
            .map(
              (x) => `<li><span class="mono">${ruleLabel(x.i)}</span><span class="dt-skip">対象外</span><span ${
                editable ? `class="dt-editable" data-dtedit="skip" data-table="${tid}" data-rule="${esc(x.r.id)}" title="クリックして編集"` : ''
              }>${x.r.skip ? esc(x.r.skip) : '<span class="placeholder">（テストしない理由を入力）</span>'}</span></li>`,
            )
            .join('')}</ul>`
        : ''
    }
  </section>`;
}

function renderDt() {
  const d = state.dt;
  const versions = state.dtVersionsBy[d.branch] ?? [];
  const isPast = d.v && (d.v !== versions.at(-1)?.id || (state.currentBranch && d.branch !== state.currentBranch));
  const editable = canEditDt();
  const tables = dtTables();
  const mx = isMx();
  // マトリクスでは、○ を付けたマスをルールと同じように数える
  const rules = tables.filter((t) => !t._deleted).flatMap((t) => (mx ? mxMarks(t) : t.rules.filter((r) => !r._deleted)));
  const none = rules.filter((r) => ruleState(r) === 'none').length;
  const missing = rules.reduce((n, r) => n + (r.skip != null ? 0 : r.cases.filter((id) => !d.cases.some((c) => c.id === id)).length), 0);
  const warn = [
    none ? (mx ? `ケースがないマスが ${none} 件あります。ケースを紐付けるか、○ を外してください` : `ケースがないルールが ${none} 件あります。ケースを紐付けるか、対象外の理由を書いてください`) : '',
    missing ? `該当するケースがない紐付けが ${missing} 件あります（赤字）` : '',
  ].filter(Boolean);
  const body = d.missing
    ? `<div class="dt-empty">このブランチには、この${mx ? '画面のマトリクス' : 'APIのディシジョンテーブル'}がまだありません。
        <div class="mono">${mx ? 'matrices' : 'decision-tables'}/${state.level}/${esc(state.api)}.yaml</div>を作成すると、ここに表示されます。</div>`
    : tables.map((t) => (mx ? mxTableHtml : dtTableHtml)(t, d.cases, editable)).join('') || '<div class="dt-empty">表がありません</div>';
  return `<div class="data-view">
    <div class="specs-head">
      <div class="pane-head">${crumb()}${paneTabs()}<div class="spacer"></div>${state.branches.length ? dtModeSwitch() : ''}</div>
      <div class="pane-head sub">
        ${branchSelect('dt-branch', d.branch)}
        ${versions.length ? `<select data-act="dt-version">${versions.map((x) => `<option value="${x.id}" ${x.id === d.v ? 'selected' : ''}>${esc(x.label)}${x === versions.at(-1) ? ' · 最新' : ''}</option>`).join('')}</select>` : ''}
        <div class="spacer"></div>
        ${d.missing ? '' : `<button class="btn primary" data-act="dt-table-add" ${editable ? '' : 'disabled'}>表を追加</button>`}
      </div>
      ${isPast ? '<div class="note">選んだブランチ・版の時点の内容です。ケース番号も、同じ時点のケースで表示しています。編集できるのは現在のブランチの最新だけです。</div>' : ''}
      ${warn.map((w) => `<div class="note warn">${w}</div>`).join('')}
      <div class="toolbar"><div class="summary">表 ${tables.filter((t) => !t._deleted).length} · ${mx ? '確認するマス' : 'ルール'} ${rules.length}</div>
        <span class="legend"><span class="lg-title">表の見方</span>${
          mx
            ? '<span class="lg"><code>○</code>確認するマス</span><span class="lg"><code>&nbsp;</code>確認しないマス</span>'
            : '<span class="lg"><code class="any">-</code>どちらでもよい</span><span class="lg"><code>✓</code>そのルールで起きる結果</span>'
        }</span></div>
    </div>
    <div class="data-wrap dt-wrap" data-scroll="dt">${body}</div>
  </div>`;
}

// ディシジョンテーブルの変更の一覧。表への移動と、表ごとの取り消しができる
function dtChangesHtml() {
  const rows = state.dtDraft.tables
    .map((t) => ({ t, c: dtTableChange(t) }))
    .filter((x) => x.c)
    .map(({ t, c }) => {
      const label = c.type === 'added' ? '追加を取り消す' : c.type === 'removed' ? '削除を取り消す' : '戻す';
      return `<div class="ch-row">
        <button class="ch-case" data-act="dt-jump" data-id="${esc(t.id)}"><span class="t">${esc(t.name)}</span><span class="f">${esc(c.what.join('、'))}</span></button>
        <button class="link" data-act="dt-table-revert" data-table="${esc(t.id)}">${label}</button>
      </div>`;
    })
    .join('');
  return `<div class="ch-title">変更の一覧</div>${rows}`;
}

/* ---------- decision table diff ---------- */

// 表・ルールは id で照合する。条件と結果の行は名前で照合する
function diffDtTable(o, n) {
  const t = n ?? o;
  const lines = (namesOf) => {
    const an = o ? namesOf(o) : [];
    const bn = n ? namesOf(n) : [];
    return [...bn.map((name) => ({ name, type: !o || an.includes(name) ? 'same' : 'added' })), ...(n ? an.filter((x) => !bn.includes(x)).map((name) => ({ name, type: 'removed' })) : [])];
  };
  const conds = lines(condNames);
  const actions = lines(actionNames);
  const key = (r) => JSON.stringify([conds.map((c) => whenOf(r, c.name)), [...(r.then ?? [])].sort(), r.cases ?? [], r.skip ?? '']);
  const before = new Map((o?.rules ?? []).map((r, i) => [r.id, { r, i }]));
  const rules = (n?.rules ?? o.rules ?? []).map((r, i) => {
    const b = n && o ? before.get(r.id) : null;
    const type = !n || !o ? 'same' : !b ? 'added' : key(b.r) === key(r) ? 'same' : 'changed';
    return { type, r, before: b?.r, label: ruleLabel(i) };
  });
  if (n && o) {
    const ids = new Set(n.rules?.map((r) => r.id));
    rules.push(...(o.rules ?? []).map((r, i) => ({ type: 'removed', r, label: ruleLabel(i) })).filter((x) => !ids.has(x.r.id)));
  }
  const nameFrom = o && n && o.name !== n.name ? o.name : null;
  const changed = nameFrom !== null || [...conds, ...actions, ...rules].some((x) => x.type !== 'same');
  return { type: !o ? 'added' : !n ? 'removed' : changed ? 'changed' : 'same', t, nameFrom, conds, actions, rules };
}
function computeDtDiff(a, b) {
  const diff = isMx() ? diffMxTable : diffDtTable;
  const before = new Map(a.tables.map((t) => [t.id, t]));
  const ids = new Set(b.tables.map((t) => t.id));
  return [...b.tables.map((t) => diff(before.get(t.id), t)), ...a.tables.filter((t) => !ids.has(t.id)).map((t) => diff(t, null))];
}

const oldNew = (from, to) => `<span class="dt-chg"><span class="del">${from}</span><span class="arrow">→</span><span class="add">${to}</span></span>`;

function dtDiffTableHtml(d) {
  const { t, rules } = d;
  const span = rules.length + 1;
  const cls = (x) => (x.type === 'same' ? '' : `dt-${x.type}`);
  const condCell = (x, name) => {
    const v = whenOf(x.r, name);
    const old = x.before && whenOf(x.before, name);
    return x.type === 'changed' && old !== v ? oldNew(dtVal(old), dtVal(v)) : dtVal(v);
  };
  const actionCell = (x, a) => {
    const now = (x.r.then ?? []).includes(a);
    const was = x.before ? (x.before.then ?? []).includes(a) : now;
    if (now && was) return '<span class="dt-check">✓</span>';
    if (now) return '<span class="ref-tag add">+ ✓</span>';
    return was ? '<span class="ref-tag del">− ✓</span>' : '';
  };
  const caseCell = (x) => {
    const now = x.r.cases ?? [];
    const was = x.before ? (x.before.cases ?? []) : now;
    // 番号はその時点の並び順で決まるので、外したケースは前の時点、それ以外は後の時点の番号で出す
    const label = (side, id) => {
      const c = side.cases.find((y) => y.id === id);
      return c ? `<span title="${esc(c.title)}">#${c.no}</span>` : esc(shortId(id));
    };
    const { a, b } = state.dtDiff;
    const tags = [
      ...now.map((id) => (was.includes(id) ? `<span class="ref-tag">${label(b, id)}</span>` : `<span class="ref-tag add">+ ${label(b, id)}</span>`)),
      ...was.filter((id) => !now.includes(id)).map((id) => `<span class="ref-tag del">− ${label(a, id)}</span>`),
    ];
    const skipNow = x.r.skip ?? '';
    const skipWas = x.before ? (x.before.skip ?? '') : skipNow;
    if (skipNow && skipNow === skipWas) tags.push('<span class="dt-skip">対象外</span>');
    else {
      if (skipNow) tags.push(`<span class="ref-tag add" title="${esc(skipNow)}">+ 対象外</span>`);
      if (skipWas) tags.push(`<span class="ref-tag del" title="${esc(skipWas)}">− 対象外</span>`);
    }
    return tags.join('') || '<span class="dt-none">ケースなし</span>';
  };
  const rowTh = (x) => `<th class="${cls(x)}">${esc(x.name)}${x.type === 'same' ? '' : `<span class="type ${x.type}">${DATA_TYPE_LABEL[x.type]}</span>`}</th>`;
  const skipNotes = rules.filter((x) => x.type !== 'removed' && x.r.skip);
  return `<section class="dt dt-t-${d.type}">
    <div class="dt-head"><span class="type ${d.type}">${DATA_TYPE_LABEL[d.type]}</span>
      <h2>${d.nameFrom !== null ? oldNew(esc(d.nameFrom), esc(t.name)) : esc(t.name)}</h2></div>
    <div class="dt-scroll"><table class="dt-table">
      <thead><tr><th class="dt-corner"></th>${rules.map((x) => `<th class="${cls(x)}">${x.label}${x.type === 'same' ? '' : `<span class="type ${x.type}">${DATA_TYPE_LABEL[x.type]}</span>`}</th>`).join('')}</tr></thead>
      <tbody>
        <tr class="dt-sec"><th colspan="${span}">条件</th></tr>
        ${d.conds.map((c) => `<tr class="${cls(c)}">${rowTh(c)}${rules.map((x) => `<td class="${cls(x)}">${condCell(x, c.name)}</td>`).join('')}</tr>`).join('')}
        <tr class="dt-sec"><th colspan="${span}">結果</th></tr>
        ${d.actions.map((a) => `<tr class="${cls(a)}">${rowTh(a)}${rules.map((x) => `<td class="${cls(x)}">${actionCell(x, a.name)}</td>`).join('')}</tr>`).join('')}
        <tr class="dt-sec"><th colspan="${span}">テスト</th></tr>
        <tr class="dt-cases"><th>ケース</th>${rules.map((x) => `<td class="${cls(x)}">${caseCell(x)}</td>`).join('')}</tr>
      </tbody>
    </table></div>
    ${skipNotes.length ? `<ul class="dt-notes">${skipNotes.map((x) => `<li><span class="mono">${x.label}</span><span class="dt-skip">対象外</span>${esc(x.r.skip)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function renderDtDiff() {
  const d = state.dtDiff;
  const tables = computeDtDiff(d.a, d.b);
  const mx = isMx();
  const rules = tables.flatMap((t) => (t.type === 'changed' ? (mx ? t.cells.flat() : t.rules) : []));
  const n = (list, type) => list.filter((x) => x.type === type).length;
  const shown = d.onlyChanged ? tables.filter((t) => t.type !== 'same') : tables;
  const options = (branch, cur) =>
    (state.dtVersionsBy[branch] ?? []).map((v) => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  return `<div class="data-view">
    <div class="diff-head">
      <div class="row">${crumb()}${paneTabs()}<div class="spacer"></div>${dtModeSwitch()}</div>
      <div class="row">
        <label>比較元</label>${branchSelect('dt-diff-from-branch', d.fromBranch)}<select data-act="dt-diff-from">${options(d.fromBranch, d.from)}</select>
        <span class="arrow">→</span>
        <label>比較先</label>${branchSelect('dt-diff-to-branch', d.toBranch)}<select data-act="dt-diff-to">${options(d.toBranch, d.to)}</select>
      </div>
      <div class="row">
        <div class="summary">表：追加 ${n(tables, 'added')} · 変更 ${n(tables, 'changed')} · 削除 ${n(tables, 'removed')} · 変更なし ${n(tables, 'same')}　${mx ? 'マス' : 'ルール'}：追加 ${n(rules, 'added')} · 変更 ${n(rules, 'changed')} · 削除 ${n(rules, 'removed')}</div>
        <label class="toggle"><input type="checkbox" data-act="dt-only-changed" ${d.onlyChanged ? 'checked' : ''}>変更のあった表のみ表示</label>
      </div>
    </div>
    <div class="data-wrap dt-wrap" data-scroll="dt-diff">${shown.map(mx ? mxDiffTableHtml : dtDiffTableHtml).join('') || '<div class="dt-empty">変更のあった表はありません</div>'}</div>
  </div>`;
}

/* ---------- reading ---------- */

function renderReading() {
  const cases = filteredCases();
  if (!cases.length) return '<div></div><div class="muted" style="padding:40px">該当するケースはありません</div>';
  state.selectedId = cases.some((c) => c.id === state.selectedId) ? state.selectedId : cases[0].id;
  const toc = cases
    .map(
      (c) => `<button class="toc-item ${c.id === state.selectedId ? 'active' : ''} ${c.status === '無効' ? 'excluded' : ''}" data-act="toc" data-id="${c.id}">
        ${caseHandle()}<span class="mono">#${c.no}</span><span class="t">${esc(c.title || '（未入力）')}</span>${c.perspective === '異常' ? '<span class="abn-dot"></span>' : ''}
      </button>`,
    )
    .join('');
  const sections = cases
    .map(
      (c) => `<section class="rcase ${c.status === '無効' ? 'excluded' : ''} ${canEdit() ? 'can-edit' : ''}" data-case="${c.id}">
        <div class="rmeta"><span class="case-no">#${c.no}</span>${caseTitle(c)}${caseMeta(c)}<div class="spacer"></div>${caseActions(c)}</div>
        ${caseDesc(c)}
        ${dataRefs(c, true)}
        ${dtRefs(c, true)}
        ${caseBody(c, true)}
      </section>`,
    )
    .join('');
  return `<nav class="toc" data-scroll="toc"><div class="toc-title">目次（${cases.length}件）</div>${toc}</nav>
    <div class="reading" data-scroll="read">${sections}</div>`;
}

function renderDetail(c) {
  return `<aside class="detail ${c.status === '無効' ? 'excluded' : ''} ${canEdit() ? 'can-edit' : ''}" data-case="${c.id}" data-scroll="detail-${c.id}">
    <div class="detail-head">
      <div class="meta-line">${caseMeta(c)}</div>
      <div class="spacer"></div>
      <button class="icon-btn" data-act="close" aria-label="閉じる">×</button>
    </div>
    <div class="detail-title"><span class="case-no">#${c.no}</span>${caseTitle(c)}</div>
    <div class="detail-actions">${caseActions(c)}</div>
    ${caseDesc(c)}
    ${dataRefs(c, false)}
    ${dtRefs(c, false)}
    ${caseBody(c, false)}
  </aside>`;
}

// スクロール位置から今読んでいるケースを判定し、目次の強調表示だけを更新する
let spyFrame;
function onReadingScroll(e) {
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(() => {
    const top = e.target.scrollTop + 24;
    let current;
    for (const sec of e.target.querySelectorAll('.rcase')) {
      if (sec.offsetTop > top) break;
      current = sec.dataset.case;
    }
    current ??= e.target.querySelector('.rcase')?.dataset.case;
    if (current && current !== state.selectedId) setTocActive(current);
  });
}

function setTocActive(id) {
  state.selectedId = id;
  document.querySelectorAll('.toc-item').forEach((el) => el.classList.toggle('active', el.dataset.id === id));
  $(`.toc-item[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}

function scrollToCase(id) {
  const sec = $(`.rcase[data-case="${id}"]`);
  if (!sec) return;
  $('.reading').scrollTop = sec.offsetTop - 8;
  setTocActive(id);
}

function moveCase(step) {
  const ids = filteredCases().map((c) => c.id);
  if (!ids.length) return;
  const i = ids.indexOf(state.selectedId);
  const next = ids[i === -1 ? 0 : Math.min(ids.length - 1, Math.max(0, i + step))];
  if (state.mode === 'read') return scrollToCase(next);
  state.selectedId = next;
  render();
  $('tr.selected')?.scrollIntoView({ block: 'nearest' });
}

/* ---------- inline editing ---------- */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function openEditor(el) {
  if (el.classList.contains('editing')) return;
  const id = el.closest('[data-case]').dataset.case;
  const { edit: path, kind } = el.dataset;
  const raw = state.draft.raw[`${id}|${path}`];
  const v = get(viewCase(id), path);
  const text = kind === 'json' ? raw ?? (isEmpty(v) ? '' : JSON.stringify(v, null, 2)) : v ?? '';
  el.classList.add('editing');
  el.innerHTML = `<textarea class="inline-input" rows="1" spellcheck="false" placeholder="${el.dataset.ph}"></textarea>`;
  const ta = el.firstChild;
  ta.value = text;
  autosize(ta);
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}

function openEditorAt(id, path) {
  const el = document.querySelector(`[data-case="${id}"] [data-edit="${path}"]`);
  if (el) openEditor(el);
}

// 入力欄から離れたら下書きに反映し、その要素だけ表示に戻す
function commitEditor(el, cancel = false) {
  const ta = el?.querySelector('.inline-input');
  if (!ta || !el.isConnected || suppressCommit) return;
  suppressCommit = true;
  try {
    applyEditor(el, ta, cancel);
  } finally {
    suppressCommit = false;
  }
}

function applyEditor(el, ta, cancel) {
  const id = el.closest('[data-case]').dataset.case;
  const { edit: path, kind } = el.dataset;
  const key = `${id}|${path}`;
  if (!cancel) {
    const c = ensureDraft(id);
    if (kind === 'json') {
      const text = ta.value.trim();
      try {
        set(c, path, text ? JSON.parse(text) : undefined);
        delete state.draft.raw[key];
      } catch {
        state.draft.raw[key] = ta.value;
      }
    } else {
      set(c, path, kind === 'line' ? ta.value.replace(/\n/g, ' ') : ta.value);
    }
  }
  // 空のまま閉じた項目・手順は残さない
  const c = viewCase(id);
  const empty = path.match(/^(.+)\.(\d+)\.(text|action)$/);
  const target = empty && get(c, `${empty[1]}.${empty[2]}`);
  if (target && !get(c, path)?.trim() && !hasCode(c, `${empty[1]}.${empty[2]}`, target) && isEmpty(target.expected)) {
    dropRaw(id, empty[1]);
    get(ensureDraft(id), empty[1]).splice(Number(empty[2]), 1);
    return renderAll();
  }
  el.classList.remove('editing');
  el.classList.toggle('invalid', key in state.draft.raw);
  el.innerHTML = displayHtml(viewCase(id), path, kind, el.dataset.ph);
  syncDirty(id);
}

// 再描画せずに、変更の印・目次・一覧の表示だけ更新する
function syncDirty(id) {
  const dirty = isDirty(id);
  if (!dirty && !rawKeys(id).length) state.draft.cases.delete(id);
  const paths = changedPaths(id);
  const title = viewCase(id).title || '（未入力）';
  document.querySelectorAll(`[data-case="${id}"]`).forEach((sec) => {
    sec.classList.toggle('dirty', dirty);
    sec.querySelectorAll('[data-field]').forEach((f) => {
      const changed = paths.includes(f.dataset.field);
      f.classList.toggle('changed', changed);
      const btn = f.querySelector(':scope > .revert');
      if (changed && REVERTIBLE(f.dataset.field) && canEdit()) {
        if (!btn) f.insertAdjacentHTML('beforeend', `<button type="button" class="revert" data-act="revert-field" data-path="${f.dataset.field}" title="この項目の変更を戻す">↺</button>`);
      } else btn?.remove();
    });
  });
  document.querySelectorAll(`.toc-item[data-id="${id}"], tr[data-id="${id}"]`).forEach((el) => {
    el.classList.toggle('dirty', dirty);
    const t = el.querySelector('.t, .c-title');
    if (t) t.textContent = title;
  });
  updateSaveBar();
}

function updateSaveBar() {
  const bar = $('#savebar');
  const isData = state.view === 'data';
  const ids = state.view === 'specs' ? dirtyIds() : [];
  const dataIds = isData && state.dataDraft ? dataDirtyRows().map((r) => r.id) : [];
  const isDt = state.view === 'dt';
  const dtN = isDt && state.dtDraft ? state.dtDraft.tables.filter(dtTableChange).length : 0;
  const n = isDt ? dtN : isData ? dataIds.length : ids.length;
  bar.classList.toggle('show', n > 0);
  if (!n) {
    bar.innerHTML = '';
    state.changesOpen = false;
    return;
  }
  if (!bar.querySelector('#save-btn')) {
    bar.innerHTML = `<div class="changes"></div>
      <div class="bar-row">
        <button class="count" data-act="toggle-changes"></button>
        <button class="btn ghost" data-act="discard">すべて破棄</button>
        <button class="btn primary" data-act="save" id="save-btn">ファイルに保存</button>
      </div>`;
  }
  const invalid = isData || isDt ? 0 : Object.keys(state.draft.raw).length;
  const count = bar.querySelector('.count');
  count.innerHTML = `${invalid ? `JSONの形式が不正です (${invalid})` : `未保存の変更 ${n}${isDt ? '表' : isData ? '件' : 'ケース'}`}<span class="caret">${state.changesOpen ? '▼' : '▲'}</span>`;
  count.classList.toggle('abn', invalid > 0);
  bar.querySelector('#save-btn').disabled = invalid > 0;
  bar.querySelector('.changes').innerHTML = state.changesOpen ? (isDt ? dtChangesHtml() : isData ? dataChangesHtml() : changesHtml(ids)) : '';
}

// テストデータの変更の一覧。レコードへの移動と、レコードごとの取り消しができる
function dataChangesHtml() {
  const rows = dataDirtyRows()
    .map((r) => {
      const { type, cols } = recChange(r);
      const what = type === 'added' ? '新規追加' : type === 'removed' ? '削除' : cols.map(colLabel).join('、');
      const label = type === 'added' ? '追加を取り消す' : type === 'removed' ? '削除を取り消す' : '戻す';
      return `<div class="ch-row">
        <button class="ch-case" data-act="data-jump" data-id="${esc(r.id)}"><span class="mono">${esc(r.id.slice(0, 8))}</span><span class="t">${esc(r.purpose || '（意図なし）')}</span><span class="f">${esc(what)}</span></button>
        <button class="link" data-act="data-revert-rec" data-id="${esc(r.id)}">${label}</button>
      </div>`;
    })
    .join('');
  return `<div class="ch-title">変更の一覧</div>${rows}`;
}

// 画面下のバーから開く変更の一覧。ケースへの移動と、ケースごと・並び順の取り消しができる
function changesHtml(ids) {
  const fields = fieldsOf(state.spec);
  const rows = ids
    .map(viewCase)
    .sort((a, b) => a.no - b.no)
    .map((c) => {
      const what = isNewCase(c.id)
        ? '新規追加'
        : changedPaths(c.id)
            .filter((p) => p !== 'no')
            .map((p) => shortLabel(fields.find((f) => f.path === p)))
            .join('、') || (rawKeys(c.id).length ? '入力途中のJSON' : '並び順');
      return `<div class="ch-row">
        <button class="ch-case" data-act="jump-case" data-id="${c.id}"><span class="mono">#${c.no}</span><span class="t">${esc(c.title || '（未入力）')}</span><span class="f">${esc(what)}</span></button>
        ${
          // 番号が変わっただけのケースは、上の「並び順」の行で戻す
          what === '並び順' ? '' : `<button class="link" data-act="revert-case" data-id="${c.id}">${isNewCase(c.id) ? '追加を取り消す' : '戻す'}</button>`
        }
      </div>`;
    })
    .join('');
  const order = isReordered()
    ? `<div class="ch-row"><span class="ch-case static"><span class="f">ケースの並び順を変更</span></span><button class="link" data-act="revert-order">戻す</button></div>`
    : '';
  return `<div class="ch-title">変更の一覧</div>${order}${rows}`;
}

// 項目の追加・削除など、ケースの構造が変わる操作。全体を描き直してから入力欄を開く
function structural(id, fn, focusPath) {
  const c = ensureDraft(id);
  fn(c);
  render();
  if (focusPath) openEditorAt(id, typeof focusPath === 'function' ? focusPath(c) : focusPath);
}

// 削除した項目より後ろは番号がずれるので、その配下の入力途中の JSON は破棄する
function dropRaw(id, path) {
  Object.keys(state.draft.raw)
    .filter((k) => k.startsWith(`${id}|${path}.`))
    .forEach((k) => delete state.draft.raw[k]);
}

async function save() {
  const d = state.draft;
  const missing = dirtyIds().map(viewCase).find((c) => !c.title?.trim());
  if (missing) return toast(`#${missing.no} のケース名を入力してください`, true);
  const cases = orderedIds().map((id) => withoutNo(d.cases.has(id) ? fromEditCase(d.cases.get(id)) : originalCase(id)));
  try {
    await request(`/api/spec?api=${encodeURIComponent(state.api)}&level=${state.level}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ etag: state.etag, cases }),
    });
    state.tree = await request('/api/tree');
    await Promise.all([loadData(state.level, true), loadDtWorking()]);
    state.versions = await versionsOf(state.branch, true);
    state.draft = emptyDraft();
    await loadVersion(latestVersion());
    render();
    toast('保存しました。版として残すには git でコミットしてください');
  } catch (err) {
    toast(err.message, true);
  }
}

// 未保存の変更があるときは、別の仕様や版へ移れないようにする
function blockedByDraft() {
  if (!hasDirty()) return false;
  toast('未保存の変更があります。保存するか破棄してください', true);
  return true;
}

/* ---------- diff ---------- */

function computeDiff(a, b) {
  const before = new Map(a.cases.map((c) => [c.id, c]));
  const afterIds = new Set(b.cases.map((c) => c.id));
  const rows = b.cases.map((c) => {
    const o = before.get(c.id);
    if (!o) return { id: c.id, type: 'added', before: null, after: c, fields: fieldsOf(b).filter((f) => !isEmpty(get(c, f.path))) };
    const fields = fieldsOf(b).filter((f) => !same(get(o, f.path), get(c, f.path)));
    // 番号だけの変更（並べ替え）は内容の変更に数えず、別にまとめて出す
    const content = fields.filter((f) => f.path !== 'no');
    const type = o.status === '有効' && c.status === '無効' ? 'excluded' : content.length ? 'changed' : 'same';
    return { id: c.id, type, before: o, after: c, fields: content.length ? fields : [], renumbered: o.no !== c.no };
  });
  a.cases.filter((c) => !afterIds.has(c.id)).forEach((c) => rows.push({ id: c.id, type: 'removed', before: c, after: null, fields: [] }));
  return rows.sort((x, y) => (x.after ?? x.before).no - (y.after ?? y.before).no);
}

function lineDiff(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push([' ', a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j], j++]);
  }
  while (i < a.length) out.push(['-', a[i++]]);
  while (j < b.length) out.push(['+', b[j], j++]);
  return out;
}
const jsonLines = (v) => (isEmpty(v) ? [] : JSON.stringify(v, null, 2).split('\n'));
const fmtValue = (f, v) => (isEmpty(v) ? '（なし）' : esc(LABEL[f.path]?.[v] ?? v));

function fieldDiff(f, a, b) {
  let body;
  if (f.kind === 'json') {
    body = `<pre class="code diff">${lineDiff(jsonLines(a), jsonLines(b))
      .map(([t, l]) => `<div class="ln ${t === '-' ? 'del' : t === '+' ? 'add' : ''}"><span class="mark">${t.trim()}</span>${esc(l)}</div>`)
      .join('')}</pre>`;
  } else if (f.kind === 'items') {
    const key = (x) => JSON.stringify(x);
    const A = (a ?? []).map(key);
    const B = (b ?? []).map(key);
    const li = (x, cls, mark) => `<li class="${cls}">${mark}${itemHtml(x)}</li>`;
    body = `<ul class="dlist">${(a ?? []).filter((x) => !B.includes(key(x))).map((x) => li(x, 'del', '− ')).join('')}${(b ?? [])
      .map((x) => (A.includes(key(x)) ? li(x, '', '') : li(x, 'add', '+ ')))
      .join('')}</ul>`;
  } else if (f.kind === 'steps') {
    // 手順は行単位で比較する。番号は比較先の番号を表示する
    // 内容が同じまま位置だけ変わった手順は、削除＋追加ではなく「移動」として新しい位置に1行で出す
    const key = (x) => JSON.stringify(x);
    const ops = lineDiff((a ?? []).map(key), (b ?? []).map(key));
    const removed = new Set(ops.filter(([t]) => t === '-').map(([, k]) => k));
    const moved = new Set(ops.filter(([t, k]) => t === '+' && removed.has(k)).map(([, k]) => k));
    body = stepsTable(
      ops
        .map(([t, k, j]) => {
          const s = JSON.parse(k);
          if (t === '-') return moved.has(k) ? '' : stepRow(s, '−', 'del');
          if (t === '+' && moved.has(k)) return stepRow(s, j + 1, 'moved');
          return stepRow(s, j + 1, t === '+' ? 'add' : '');
        })
        .join(''),
    );
  } else if (same(a, b)) {
    body = `<div class="inline-diff"><span class="same">${fmtValue(f, b)}</span></div>`;
  } else {
    body = `<div class="inline-diff">${a === undefined ? '' : `<span class="del">${fmtValue(f, a)}</span><span class="arrow">→</span>`}<span class="add">${fmtValue(f, b)}</span></div>`;
  }
  return `<div class="fdiff"><div class="fdiff-label">${f.label}</div>${body}</div>`;
}

function renderDiff() {
  const d = state.diff;
  const rows = computeDiff(d.a, d.b);
  const n = (t) => rows.filter((r) => r.type === t).length;
  const shown = d.onlyChanged ? rows.filter((r) => r.type !== 'same') : rows;
  const sel = shown.find((r) => r.id === d.selectedId) ?? shown[0];
  const versionOptions = (branch, cur) =>
    (state.versionsBy[branch] ?? []).map((v) => `<option value="${v.id}" ${v.id === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('');

  const list = shown
    .map((r) => {
      const c = r.after ?? r.before;
      const summary = r.type === 'added' ? '新規ケース' : r.fields.map(shortLabel).join(', ');
      return `<div class="drow ${r.id === sel?.id ? 'selected' : ''}" data-act="diff-select" data-id="${r.id}">
        <span class="type ${r.type}">${TYPE_LABEL[r.type]}</span>
        <span class="mono muted">#${c.no}</span>
        <span class="t">${esc(c.title)}</span>
        <span class="f">${esc(summary)}</span>
      </div>`;
    })
    .join('');

  let detail = '<div class="muted">変更のあったケースはありません</div>';
  if (sel) {
    const c = sel.after ?? sel.before;
    const unchanged = fieldsOf(d.b).filter((f) => !sel.fields.includes(f) && !isEmpty(get(c, f.path)));
    const changedHtml =
      sel.type === 'removed'
        ? '<p class="muted">このケースは削除されました</p>'
        : sel.fields.map((f) => fieldDiff(f, sel.before ? get(sel.before, f.path) : undefined, get(sel.after, f.path))).join('') ||
          '<p class="muted">変更はありません</p>';
    detail = `<div class="meta-line"><span class="type ${sel.type}">${TYPE_LABEL[sel.type]}</span> · UUIDで照合 <span class="mono">${sel.id.slice(0, 8)}…</span></div>
      <h2>#${c.no} ${esc(c.title)}</h2>
      ${changedHtml}
      ${
        sel.type === 'added' || sel.type === 'removed' || !unchanged.length
          ? ''
          : `<div class="same-toggle"><button class="link" data-act="toggle-same">${d.showSame ? '変更なしの項目を隠す' : `変更なしの項目 (${unchanged.length}) を表示`}</button>
             ${d.showSame ? unchanged.map((f) => fieldDiff(f, get(c, f.path), get(c, f.path))).join('') : ''}</div>`
      }`;
  }

  const renumbered = rows.filter((r) => r.renumbered);
  const reorderHtml = renumbered.length
    ? `<details class="reorder"><summary>順番の変更 ${renumbered.length}件</summary><ul>${renumbered
        .map((r) => `<li><span class="mono">#${r.before.no} → #${r.after.no}</span>${esc(r.after.title)}</li>`)
        .join('')}</ul></details>`
    : '';
  return `<div class="diff-view">
    <div class="diff-head">
      <div class="row">${crumb()}${paneTabs()}<div class="spacer"></div>${caseModeSwitch()}</div>
      <div class="row">
        <label>比較元</label>${branchSelect('diff-from-branch', d.fromBranch)}<select data-act="diff-from">${versionOptions(d.fromBranch, d.from)}</select>
        <span class="arrow">→</span>
        <label>比較先</label>${branchSelect('diff-to-branch', d.toBranch)}<select data-act="diff-to">${versionOptions(d.toBranch, d.to)}</select>
      </div>
      <div class="row">
        <div class="summary">追加 ${n('added')} · 変更 ${n('changed')} · 無効化 ${n('excluded')}${n('removed') ? ` · 削除 ${n('removed')}` : ''} · 変更なし ${n('same')}</div>
        ${reorderHtml}
        <label class="toggle"><input type="checkbox" data-act="only-changed" ${d.onlyChanged ? 'checked' : ''}>変更のあったケースのみ表示</label>
      </div>
    </div>
    <div class="diff-body">
      <div class="diff-list" data-scroll="diff-list">${list || '<div class="muted" style="padding:24px">変更はありません</div>'}</div>
      <div class="diff-detail" data-scroll="diff-${sel?.id}">${detail}</div>
    </div>
  </div>`;
}

let toastTimer;
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${error ? 'error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 2600);
}

/* ---------- events ---------- */

document.addEventListener('click', async (e) => {
  const editable = e.target.closest('.editable');
  if (editable && !e.target.closest('.revert')) return openEditor(editable);
  const setBtn = e.target.closest('.cell-tools [data-set]');
  if (setBtn) return commitCellEditor(setBtn.closest('td'), setBtn.dataset.set);
  const dtEdit = e.target.closest('[data-dtedit]');
  if (dtEdit && !e.target.closest('button, input')) return openDtEditor(dtEdit);
  const dtCell = e.target.closest('td.dt-cell');
  if (dtCell && !e.target.closest('select')) {
    const t = ensureDtDraft().tables.find((x) => x.id === dtCell.dataset.table);
    const r = t.rules.find((x) => x.id === dtCell.dataset.rule);
    if (dtCell.dataset.kind === 'action') {
      const a = t.actions[dtCell.dataset.action].name;
      r.then = r.then.includes(a) ? r.then.filter((x) => x !== a) : [...r.then, a];
      settleDtDraft();
      return render();
    }
    const c = t.conditions[dtCell.dataset.cond];
    const cur = whenOf(r, c.name);
    const opts = [...new Set([...c.values, '-', cur])];
    return openDtSelect(dtCell, `<select class="dt-select" data-kind="cond">${opts.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${v === '-' ? '-（どちらでもよい）' : esc(v)}</option>`).join('')}</select>`);
  }
  const ecell = e.target.closest('td.ecell');
  if (ecell && !e.target.closest('button, a, select, textarea')) return openCellEditor(ecell);
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  const { id, path } = el.dataset;
  const caseId = el.closest('[data-case]')?.dataset.case;
  switch (el.dataset.act) {
    case 'data-table': {
      if (blockedByDraft()) return;
      // 差分を見ているときは、別のテーブルでも差分を開く
      const diff = state.view === 'data-diff';
      await openData(el.dataset.level, el.dataset.table);
      return diff ? openDataDiff() : undefined;
    }
    case 'data-mode':
      if (el.dataset.viewTo === state.view) return;
      if (blockedByDraft()) return;
      if (el.dataset.viewTo === 'data-diff') return openDataDiff({ to: state.dataSel.v });
      state.view = 'data';
      return render();
    case 'open-case-data': {
      if (blockedByDraft()) return;
      const c = viewCase(el.dataset.id);
      return openData(state.level, el.dataset.table, { caseId: c.id, caseLabel: `${state.spec.meta.name} #${c.no} ${c.title}` });
    }
    case 'clear-data-filter': {
      const { level, table, branch, v } = state.dataSel;
      return openData(level, table, { branch, v });
    }
    case 'mx-row-add':
    case 'mx-col-add':
    case 'mx-move':
    case 'mx-on':
    case 'mx-off':
    case 'mx-case-remove':
    case 'dt-rule-add':
    case 'dt-rule-left':
    case 'dt-rule-right':
    case 'dt-row-move':
    case 'dt-rule-dup':
    case 'dt-rule-del':
    case 'dt-rule-revert':
    case 'dt-case-remove':
    case 'dt-skip-on':
    case 'dt-skip-off':
    case 'dt-cond-add':
    case 'dt-action-add':
    case 'dt-row-del':
    case 'dt-table-del':
    case 'dt-table-revert':
    case 'dt-table-add': {
      const act = el.dataset.act;
      const d = ensureDtDraft();
      const t = d.tables.find((x) => x.id === (el.dataset.table ?? el.closest('td')?.dataset.table));
      const r = t?.rules?.find((x) => x.id === el.dataset.rule);
      let after;
      // マトリクスのマス。行・列は、表の中の位置で受け取る
      const td = el.closest('td');
      const [mr, mc] = [t?.rows?.[td?.dataset.row]?.name, t?.cols?.[td?.dataset.col]?.name];
      const swap = (list, i, j) => ([list[i], list[j]] = [list[j], list[i]]);
      if (act === 'mx-on') t.cells.push({ row: mr, col: mc, cases: [] });
      else if (act === 'mx-off') t.cells = t.cells.filter((c) => !(c.row === mr && c.col === mc));
      else if (act === 'mx-case-remove') mxCell(t, mr, mc).cases.splice(Number(el.dataset.index), 1);
      else if (act === 'mx-move') {
        const i = Number(el.dataset.index);
        swap(el.dataset.kind === 'mxrow' ? t.rows : t.cols, i, i + Number(el.dataset.dir));
      } else if (act === 'mx-row-add' || act === 'mx-col-add') {
        const [list, kind] = act === 'mx-row-add' ? [t.rows, 'mxrow'] : [t.cols, 'mxcol'];
        list.push({ name: '' });
        after = `[data-dtedit="${kind}"][data-table="${t.id}"][data-index="${list.length - 1}"]`;
      } else if (act === 'dt-rule-add') t.rules.push(newDtRule(t));
      else if (act === 'dt-rule-left' || act === 'dt-rule-right') {
        const i = t.rules.indexOf(r);
        swap(t.rules, i, i + (act === 'dt-rule-left' ? -1 : 1));
      } else if (act === 'dt-row-move') {
        const i = Number(el.dataset.index);
        swap(el.dataset.kind === 'cond' ? t.conditions : t.actions, i, i + Number(el.dataset.dir));
      }
      else if (act === 'dt-rule-dup') t.rules.splice(t.rules.indexOf(r) + 1, 0, newDtRule(t, r));
      else if (act === 'dt-rule-del') r._new ? t.rules.splice(t.rules.indexOf(r), 1) : (r._deleted = true);
      else if (act === 'dt-rule-revert') revertDtRule(t, r);
      else if (act === 'dt-case-remove') r.cases.splice(Number(el.dataset.index), 1);
      else if (act === 'dt-skip-off') r.skip = undefined;
      else if (act === 'dt-skip-on') {
        r.skip = '';
        r.cases = [];
        after = `[data-dtedit="skip"][data-rule="${r.id}"]`;
      } else if (act === 'dt-cond-add') {
        t.conditions.push({ name: '', values: [] });
        after = `[data-dtedit="cond"][data-table="${t.id}"][data-index="${t.conditions.length - 1}"]`;
      } else if (act === 'dt-action-add') {
        t.actions.push({ name: '' });
        after = `[data-dtedit="action"][data-table="${t.id}"][data-index="${t.actions.length - 1}"]`;
      } else if (act === 'dt-row-del') {
        const i = Number(el.dataset.index);
        if (el.dataset.kind === 'mxrow' || el.dataset.kind === 'mxcol') {
          const [list, key] = el.dataset.kind === 'mxrow' ? [t.rows, 'row'] : [t.cols, 'col'];
          const [x] = list.splice(i, 1);
          t.cells = t.cells.filter((c) => c[key] !== x.name);
        } else if (el.dataset.kind === 'cond') {
          const [c] = t.conditions.splice(i, 1);
          t.rules.forEach((x) => delete x.when[c.name]);
        } else {
          const [a] = t.actions.splice(i, 1);
          t.rules.forEach((x) => (x.then = x.then.filter((y) => y !== a.name)));
        }
      } else if (act === 'dt-table-del') t._new ? d.tables.splice(d.tables.indexOf(t), 1) : (t._deleted = true);
      else if (act === 'dt-table-revert') {
        const i = d.tables.indexOf(t);
        t._new ? d.tables.splice(i, 1) : (d.tables[i] = toDtModel([origDtTable(t.id)])[0]);
      } else if (act === 'dt-table-add') {
        const nt = { id: crypto.randomUUID(), name: '新しい表', ...(isMx() ? { rows: [], cols: [], cells: [] } : { conditions: [], actions: [], rules: [] }), _new: true };
        d.tables.push(nt);
        after = `[data-dtedit="tname"][data-table="${nt.id}"]`;
      }
      // 入力欄を開く操作のときは、空の行を消さないよう下書きを整理しない
      if (!after) settleDtDraft();
      render();
      const target = after && $(after);
      target?.scrollIntoView({ block: 'nearest' });
      return target && openDtEditor(target);
    }
    case 'dt-case-add': {
      const td = el.closest('td');
      const t = dtTables().find((x) => x.id === td.dataset.table);
      const r = isMx() ? mxCell(t, t.rows[td.dataset.row].name, t.cols[td.dataset.col].name) : t.rules.find((x) => x.id === td.dataset.rule);
      const opts = state.dt.cases.filter((c) => !r.cases.includes(c.id));
      return openDtSelect(td, `<select class="dt-select" data-kind="case"><option value="">ケースを選択</option>${opts.map((c) => `<option value="${c.id}">#${c.no} ${esc(c.title)}${c.status === '無効' ? '（無効）' : ''}</option>`).join('')}</select>`);
    }
    case 'dt-jump': {
      const sec = $(`section[data-dt="${id}"]`);
      sec?.scrollIntoView({ block: 'start' });
      sec?.classList.add('flash');
      return setTimeout(() => sec?.classList.remove('flash'), 1200);
    }
    case 'pane':
      if ((el.dataset.pane === 'dt') === isDtView()) return;
      if (blockedByDraft()) return;
      if (el.dataset.pane === 'dt') return openDt();
      state.view = 'specs';
      return render();
    case 'dt-mode':
      if (el.dataset.viewTo === state.view) return;
      if (blockedByDraft()) return;
      return el.dataset.viewTo === 'dt-diff' ? openDtDiff({ to: state.dt?.v }) : openDt({ branch: state.dt?.branch, v: state.dt?.v });
    case 'dt-list-toggle': {
      const id = el.dataset.table;
      if (!state.dtListOpen.delete(id)) state.dtListOpen.add(id);
      render();
      break;
    }
    case 'open-dt-rule':
      if (blockedByDraft()) return;
      return openDt({ branch: state.currentBranch ?? state.branch, focus: { table: el.dataset.table, rule: el.dataset.rule } });
    case 'open-case':
      if (blockedByDraft()) return;
      state.view = 'specs';
      await selectSpec(el.dataset.api, el.dataset.level);
      state.mode = 'list';
      state.selectedId = id;
      return render();
    case 'toggle-sidebar':
      state.sidebarOpen = !state.sidebarOpen;
      storage.set('testspec.sidebar', state.sidebarOpen ? 'open' : 'closed');
      return render();
    case 'mode':
      if (el.dataset.mode === 'diff') return state.view === 'diff' ? undefined : openDiff({ to: state.version });
      if (state.view === 'specs' && state.mode === el.dataset.mode) return;
      state.mode = el.dataset.mode;
      state.view = 'specs';
      render();
      if (state.mode === 'read' && state.selectedId) scrollToCase(state.selectedId);
      else $('tr.selected')?.scrollIntoView({ block: 'nearest' });
      return;
    case 'toc':
      return scrollToCase(id);
    case 'level':
      if (blockedByDraft()) return;
      return selectSpec(el.dataset.api, el.dataset.level);
    case 'select':
      state.selectedId = id;
      return render();
    case 'close':
      state.selectedId = null;
      return render();
    case 'new-case': {
      const c = newCaseTemplate();
      state.draft.cases.set(c.id, c);
      state.draft.newIds.push(c.id);
      state.draft.order?.push(c.id);
      state.selectedId = c.id;
      Object.assign(state.filters, { q: '', perspective: '', execution: '', status: '' });
      render();
      if (state.mode === 'read') scrollToCase(c.id);
      else $('tr.selected')?.scrollIntoView({ block: 'nearest' });
      return openEditorAt(c.id, 'title');
    }
    case 'drop-new':
      state.draft.cases.delete(id);
      state.draft.newIds = state.draft.newIds.filter((x) => x !== id);
      if (state.draft.order) reorderCases(state.draft.order.filter((x) => x !== id));
      rawKeys(id).forEach((k) => delete state.draft.raw[k]);
      state.selectedId = null;
      return render();
    case 'toggle-status': {
      const c = ensureDraft(id);
      c.status = c.status === '無効' ? '有効' : '無効';
      return render();
    }
    case 'copy-uuid':
      await navigator.clipboard.writeText(id);
      return toast(`UUIDをコピーしました：${id}`);
    case 'add-item':
      return structural(caseId, (c) => set(c, path, [...(get(c, path) ?? []), { text: '' }]), (c) => `${path}.${get(c, path).length - 1}.text`);
    case 'add-code':
      return structural(caseId, (c) => (get(c, path).code = null), `${path}.code`);
    case 'add-step':
      return structural(caseId, (c) => (c.steps = [...(c.steps ?? []), { action: '', expected: [] }]), (c) => `steps.${c.steps.length - 1}.action`);
    case 'remove-item':
      dropRaw(caseId, path);
      return structural(caseId, (c) => get(c, path).splice(Number(el.dataset.index), 1));
    case 'revert-field':
      revertField(caseId, path);
      return render();
    case 'revert-case':
      revertCase(id);
      return render();
    case 'revert-order':
      revertOrder();
      return render();
    case 'toggle-changes':
      state.changesOpen = !state.changesOpen;
      return updateSaveBar();
    case 'jump-case':
      state.selectedId = id;
      render();
      if (state.mode === 'read') scrollToCase(id);
      else $('tr.selected')?.scrollIntoView({ block: 'nearest' });
      return;
    case 'discard':
      if (state.view === 'data') (state.dataDraft = null), (state.dataPicker = null);
      else if (state.view === 'dt') state.dtDraft = null;
      else state.draft = emptyDraft();
      render();
      return toast('変更を破棄しました');
    case 'save':
      return state.view === 'dt' ? saveDtDraft() : state.view === 'data' ? saveDataDraft() : save();
    case 'data-add': {
      const rec = newDataRec();
      ensureDataDraft().rows.push(rec);
      render();
      const td = $(`tr[data-rec="${rec.id}"] td.purpose`);
      td?.scrollIntoView({ block: 'nearest' });
      return td && openCellEditor(td);
    }
    case 'data-dup': {
      const rows = ensureDataDraft().rows;
      const i = rows.findIndex((r) => r.id === id);
      const rec = newDataRec(rows[i]);
      rows.splice(i + 1, 0, rec);
      render();
      const td = $(`tr[data-rec="${rec.id}"] td.purpose`);
      return td && openCellEditor(td);
    }
    case 'data-del': {
      const rows = ensureDataDraft().rows;
      const i = rows.findIndex((r) => r.id === id);
      if (rows[i]._new) rows.splice(i, 1);
      else rows[i]._deleted = true;
      settleDataDraft();
      return render();
    }
    case 'data-revert-rec':
      revertDataRec(id);
      return render();
    case 'data-revert-cell':
      revertDataCell(el.dataset.rec, el.dataset.col);
      return render();
    case 'data-ref-remove':
      ensureDataDraft();
      dataRow(el.dataset.rec).cases.splice(Number(el.dataset.index), 1);
      settleDataDraft();
      return render();
    case 'data-ref-add':
      state.dataPicker = { rec: el.dataset.rec, name: state.dataView.catalog[0]?.name };
      return render();
    case 'data-pick-cancel':
      state.dataPicker = null;
      return render();
    case 'data-pick-ok': {
      const picker = el.closest('.ref-picker');
      const ref = picker.querySelector('.pick-no').value;
      state.dataPicker = null;
      if (!ref) return render();
      ensureDataDraft();
      const r = dataRow(el.dataset.rec);
      if (!r.cases.includes(ref)) r.cases.push(ref);
      settleDataDraft();
      return render();
    }
    case 'data-jump': {
      const tr = $(`tr[data-rec="${id}"]`);
      if (!tr) return toast('絞り込みで非表示になっています', true);
      tr.scrollIntoView({ block: 'center' });
      tr.classList.add('flash');
      return setTimeout(() => tr.classList.remove('flash'), 1200);
    }
    case 'diff-select':
      state.diff.selectedId = id;
      state.diff.showSame = false;
      return render();
    case 'toggle-same':
      state.diff.showSame = !state.diff.showSame;
      return render();
  }
});

// 「-」「NULL」などのボタンで入力欄のフォーカスが外れないようにする
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.cell-tools, .dt-editor button')) e.preventDefault();
});

document.addEventListener('focusout', (e) => {
  if (e.target.classList?.contains('inline-input')) commitEditor(e.target.closest('.editable'));
  // 「-」「NULL」などのボタンを押したときは、ボタンの方で確定する
  // ディシジョンテーブルの入力欄。同じ入力欄の中（名前 → 値）の移動では確定しない
  if (e.target.classList?.contains('dt-input') && !suppressCommit) {
    const editor = e.target.closest('.dt-editor');
    if (!editor.contains(e.relatedTarget)) commitDtEditor(editor.parentElement);
  }
  if (e.target.classList?.contains('dt-select') && !suppressCommit) {
    settleDtDraft();
    render();
  }
  if (e.target.classList?.contains('cell-input') && !suppressCommit && !e.relatedTarget?.closest?.('.cell-tools')) {
    commitCellEditor(e.target.closest('td'), e.target.value);
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.classList.contains('dt-select')) {
    const td = el.closest('td');
    const t = ensureDtDraft().tables.find((x) => x.id === td.dataset.table);
    const r = isMx() ? mxCell(t, t.rows[td.dataset.row].name, t.cols[td.dataset.col].name) : t.rules.find((x) => x.id === td.dataset.rule);
    if (el.dataset.kind === 'cond') r.when[t.conditions[td.dataset.cond].name] = el.value;
    else if (el.value) {
      const noOf = (id) => state.dt.cases.find((c) => c.id === id)?.no ?? Infinity;
      r.cases = [...r.cases, el.value].sort((a, b) => noOf(a) - noOf(b));
    }
    settleDtDraft();
    return render();
  }
  if (el.dataset.kind === 'enum') {
    ensureDraft(el.closest('[data-case]').dataset.case)[el.dataset.edit] = el.value;
    return render();
  }
  if (el.dataset.filter && el.tagName === 'SELECT') {
    state.filters[el.dataset.filter] = el.value;
    return render();
  }
  switch (el.dataset.act) {
    case 'version':
      if (blockedByDraft()) return render();
      await loadVersion(el.value);
      return render();
    case 'branch':
      if (blockedByDraft()) return render();
      return selectBranch(el.value);
    case 'diff-from':
      return openDiff({ ...state.diff, from: el.value });
    case 'diff-to':
      return openDiff({ ...state.diff, to: el.value });
    case 'diff-from-branch':
      return openDiff({ ...state.diff, fromBranch: el.value, from: undefined });
    case 'diff-to-branch':
      return openDiff({ ...state.diff, toBranch: el.value, to: undefined });
    case 'data-pick-name':
      state.dataPicker.name = el.value;
      return render();
    case 'data-branch': {
      if (blockedByDraft()) return render();
      const { level, table, caseId, caseLabel } = state.dataSel;
      return openData(level, table, { branch: el.value, caseId, caseLabel });
    }
    case 'data-version': {
      if (blockedByDraft()) return render();
      const { level, table, branch, caseId, caseLabel } = state.dataSel;
      return openData(level, table, { branch, v: el.value, caseId, caseLabel });
    }
    case 'data-diff-from':
      return openDataDiff({ ...state.dataDiff, from: el.value });
    case 'data-diff-to':
      return openDataDiff({ ...state.dataDiff, to: el.value });
    case 'data-diff-from-branch':
      return openDataDiff({ ...state.dataDiff, fromBranch: el.value, from: undefined });
    case 'data-diff-to-branch':
      return openDataDiff({ ...state.dataDiff, toBranch: el.value, to: undefined });
    case 'dt-branch':
      if (blockedByDraft()) return render();
      return openDt({ branch: el.value });
    case 'dt-version':
      if (blockedByDraft()) return render();
      return openDt({ branch: state.dt.branch, v: el.value });
    case 'dt-diff-from':
      return openDtDiff({ ...state.dtDiff, from: el.value });
    case 'dt-diff-to':
      return openDtDiff({ ...state.dtDiff, to: el.value });
    case 'dt-diff-from-branch':
      return openDtDiff({ ...state.dtDiff, fromBranch: el.value, from: undefined });
    case 'dt-diff-to-branch':
      return openDtDiff({ ...state.dtDiff, toBranch: el.value, to: undefined });
    case 'dt-only-changed':
      state.dtDiff.onlyChanged = el.checked;
      return render();
    case 'data-only-changed':
      state.dataDiff.onlyChanged = el.checked;
      return render();
    case 'only-changed':
      state.diff.onlyChanged = el.checked;
      return render();
  }
});

function onSearchInput(el) {
  state.filters.q = el.value;
  render();
  const input = $('[data-filter="q"]');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.classList.contains('inline-input')) return autosize(el);
  if (el.dataset.filter === 'q' && !e.isComposing) onSearchInput(el);
});

document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (el.classList?.contains('dt-input')) {
    if (e.isComposing) return;
    const host = el.closest('.dt-editor').parentElement;
    if (e.key === 'Escape') e.preventDefault(), commitDtEditor(host, true);
    else if (e.key === 'Enter') e.preventDefault(), commitDtEditor(host);
    return;
  }
  // テストデータのセル。Enter で確定、Shift+Enter で改行、Esc で取り消し
  if (el.classList?.contains('cell-input')) {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      commitCellEditor(el.closest('td'), el.value, true);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitCellEditor(el.closest('td'), el.value);
    }
    return;
  }
  if (el.classList?.contains('inline-input')) {
    if (e.isComposing) return;
    const editable = el.closest('.editable');
    if (e.key === 'Escape') {
      e.preventDefault();
      commitEditor(editable, true);
    } else if (e.key === 'Enter' && (editable.dataset.kind === 'line' ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      el.blur();
    }
    return;
  }
  if (el.classList?.contains('editable') && e.key === 'Enter') {
    e.preventDefault();
    return openEditor(el);
  }
  if (state.view !== 'specs' || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (el.closest?.('input, textarea, select')) return;
  const step = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[e.key];
  if (step) {
    e.preventDefault();
    return moveCase(step);
  }
  if (e.key === 'Escape' && state.mode === 'list' && state.selectedId) {
    state.selectedId = null;
    render();
  }
});

document.addEventListener('compositionend', (e) => {
  if (e.target.dataset?.filter === 'q') onSearchInput(e.target);
});

/* ---------- 手順の並べ替え（ドラッグ） ---------- */

let dragStep = null; // 手順: { id, from, to }
let dragCase = null; // ケース: { id, before }
const clearDropMarks = () => document.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));

document.addEventListener('dragstart', (e) => {
  const handle = e.target.closest?.('.drag');
  if (handle?.classList.contains('case-drag')) {
    const row = handle.closest('[data-id]');
    dragCase = { id: row.dataset.id, before: null };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.setDragImage(row, 16, 16);
    row.classList.add('dragging');
    return;
  }
  const tr = handle?.closest('tr');
  if (!tr) return;
  dragStep = { id: tr.closest('[data-case]').dataset.case, from: Number(tr.dataset.step), to: null };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  e.dataTransfer.setDragImage(tr, 16, 16);
  tr.classList.add('dragging');
});

// 行の上半分なら前、下半分なら後ろに入れる
const dropMark = (el, after) => {
  document.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  el.classList.add(after ? 'drop-after' : 'drop-before');
};
const isAfter = (el, e) => {
  const r = el.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};

document.addEventListener('dragover', (e) => {
  if (dragCase) {
    const row = e.target.closest?.('tr[data-id], .toc-item');
    if (!row) return;
    e.preventDefault();
    const after = isAfter(row, e);
    dropMark(row, after);
    // 「この ID の前に入れる」で持つ。末尾なら null
    const ids = filteredCases().map((c) => c.id);
    dragCase.before = after ? ids[ids.indexOf(row.dataset.id) + 1] ?? null : row.dataset.id;
    dragCase.dropped = true;
    return;
  }
  if (!dragStep) return;
  const tr = e.target.closest?.('tr[data-step]');
  if (!tr || tr.closest('[data-case]').dataset.case !== dragStep.id) return;
  e.preventDefault();
  const r = tr.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  document.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  tr.classList.add(after ? 'drop-after' : 'drop-before');
  dragStep.to = Number(tr.dataset.step) + (after ? 1 : 0);
});

document.addEventListener('drop', (e) => {
  if (dragCase) {
    e.preventDefault();
    const { id, before, dropped } = dragCase;
    dragCase = null;
    clearDropMarks();
    if (!dropped || before === id) return;
    const ids = orderedIds().filter((x) => x !== id);
    const at = before == null ? ids.length : ids.indexOf(before);
    ids.splice(at, 0, id);
    reorderCases(ids);
    return render();
  }
  if (!dragStep) return;
  e.preventDefault();
  const { id, from, to } = dragStep;
  dragStep = null;
  clearDropMarks();
  if (to == null || to === from || to === from + 1) return;
  dropRaw(id, 'steps');
  structural(id, (c) => {
    const [step] = c.steps.splice(from, 1);
    c.steps.splice(to > from ? to - 1 : to, 0, step);
  });
});

document.addEventListener('dragend', () => {
  dragStep = null;
  dragCase = null;
  clearDropMarks();
});

window.addEventListener('beforeunload', (e) => {
  if (hasDirty()) e.preventDefault();
});

(async () => {
  const [tree, { current, branches }] = await Promise.all([request('/api/tree'), request('/api/branches')]);
  state.tree = tree;
  Object.assign(state, { branches, currentBranch: current, branch: current });
  const first = state.tree.items[0];
  if (first) await selectSpec(first.levels[0].api, first.levels[0].level);
})();
