import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import { toYaml, toDtYaml } from './lib/yaml.mjs';
import { parseCsv, stringifyCsv } from './lib/csv.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 4173;
const LEVELS = ['ita', 'itb'];
// ファイル名は自由。ただしパスの区切りや隠しファイルは受け付けない
const NAME = /^[^/\\.][^/\\]*$/;
const HASH = /^[0-9a-f]{40}$/;
const WORKING = 'working';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// --dir でサーバーのリポジトリを指定すると、その中の test-specs/ を開く。指定がなければ npm run sample で作るサンプルを開く
const { values: args } = parseArgs({ options: { dir: { type: 'string' } } });
const repoDir = path.resolve(args.dir ?? path.join(root, 'sample', 'user-service'));
const specsDir = path.join(repoDir, 'test-specs');
// テストデータの定義。実データの CSV と同じくレベルごと・テーブルごとに 1 ファイル（test-data/<level>/<table>.csv）
const dataDir = path.join(repoDir, 'test-data');
// ディシジョンテーブル。API・画面ごとに、ケースと同じファイル名で 1 ファイル（decision-tables/<level>/<api>.yaml）
const dtDir = path.join(repoDir, 'decision-tables');
const dtFile = (api, level) => path.join(dtDir, level, `${api}.yaml`);
const serverName = path.basename(repoDir);
try {
  await fs.access(specsDir);
} catch {
  console.error(`テストケースのディレクトリが見つかりません: ${specsDir}`);
  if (!args.dir) console.error('サンプルを使う場合は、先に npm run sample を実行してください。');
  process.exit(1);
}

// test-specs/<level>/<api>.yaml を 1 ファイルとし、版は git の履歴から取り出す
const relPath = (api, level) => `${level}/${api}.yaml`;
const filePath = (api, level) => path.join(specsDir, relPath(api, level));
const etagOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

const run = promisify(execFile);
const git = async (...a) => (await run('git', a, { cwd: specsDir, maxBuffer: 64 * 1024 * 1024 })).stdout;

async function currentBranch() {
  try {
    return (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  } catch {
    return null; // git 管理外
  }
}

// ローカルのブランチと、fetch 済みのリモートのブランチ
async function getBranches() {
  const current = await currentBranch();
  if (!current) return { current: null, branches: [] };
  // origin/HEAD はブランチではないので除く
  const out = await git('for-each-ref', '--format=%(refname)%09%(refname:short)', 'refs/heads', 'refs/remotes');
  const branches = out
    .split('\n')
    .filter((l) => l && !l.split('\t')[0].endsWith('/HEAD'))
    .map((l) => l.split('\t')[1]);
  return { current, branches };
}

async function checkBranch(branch) {
  const { branches } = await getBranches();
  if (!branches.includes(branch)) throw Object.assign(new Error('ブランチが見つかりません'), { status: 400 });
}

// 指定したブランチから見えるコミット。ファイル名を変えても追えるように --follow を付け、各コミット時点のパスも取る
async function commitsOf(file, branch) {
  let out;
  try {
    out = await git('log', branch, '--follow', '--name-only', '--date=short', '--format=%x00%H%x1f%ad%x1f%an%x1f%s', '--', file);
  } catch {
    return []; // git 管理外、またはそのブランチにファイルがない
  }
  return out
    .split('\0')
    .filter((s) => s.trim())
    .map((s) => {
      const [head, ...files] = s.split('\n').filter(Boolean);
      const [hash, date, author, message] = head.split('\x1f');
      return { hash, date, author, message, path: files.at(-1) };
    })
    .reverse(); // 古い順
}

async function isUncommitted(file) {
  try {
    return (await git('status', '--porcelain', '--', file)).trim() !== '';
  } catch {
    return true;
  }
}

// 末尾が最新の版。チェックアウト中のブランチで未コミットの変更があるときは「作業中」を末尾にする
async function getVersions(file, branch) {
  const current = await currentBranch();
  if (current) await checkBranch(branch);
  const commits = current ? await commitsOf(file, branch) : [];
  const versions = commits.map((c) => ({ id: c.hash, label: `${c.hash.slice(0, 7)} · ${c.date} · ${c.message}`, author: c.author }));
  if (!current || (branch === current && (!commits.length || (await isUncommitted(file))))) {
    versions.push({ id: WORKING, label: '作業中（未コミット）' });
  }
  return versions;
}

// 指定した版のファイルの中身。作業中のファイルと同じ内容になる版は working: true を返す。コミットの版は hash も返す
async function readAt(file, v, branch) {
  if (v === WORKING) return { working: true, text: await fs.readFile(file, 'utf8') };
  const current = await currentBranch();
  await checkBranch(branch);
  const commits = await commitsOf(file, branch);
  if (branch === current && v === commits.at(-1)?.hash && !(await isUncommitted(file))) {
    return { working: true, text: await fs.readFile(file, 'utf8') };
  }
  const c = commits.find((x) => x.hash === v);
  if (!c) throw Object.assign(new Error('指定された版が見つかりません'), { status: 404 });
  return { working: false, hash: c.hash, text: await git('show', `${c.hash}:${c.path}`) };
}

async function readWorking(api, level) {
  const text = await fs.readFile(filePath(api, level), 'utf8');
  return { ...yaml.load(text), etag: etagOf(text) };
}

// チェックアウト中のブランチの最新は、編集の基準にできるよう etag を付けて返す
async function readSpec(api, level, v, branch) {
  const { working, text } = await readAt(filePath(api, level), v, branch);
  return working ? { ...yaml.load(text), etag: etagOf(text) } : yaml.load(text);
}

// サイドバー用。名前（〇〇API / 〇〇画面）ごとに、その下にレベルをまとめる
async function getTree() {
  const tree = [];
  const byApi = new Map();
  for (const level of LEVELS) {
    let files = [];
    try {
      files = await fs.readdir(path.join(specsDir, level));
    } catch {
      continue;
    }
    for (const f of files.filter((x) => x.endsWith('.yaml')).sort()) {
      const api = f.slice(0, -5);
      if (!NAME.test(api)) continue;
      const spec = yaml.load(await fs.readFile(filePath(api, level), 'utf8'));
      const name = spec.meta?.name || api;
      if (!byApi.has(name)) {
        byApi.set(name, { name, levels: [] });
        tree.push(byApi.get(name));
      }
      byApi.get(name).levels.push({ level, api, count: spec.cases?.length ?? 0, dt: (await readDtWorking(api, level))?.tables.length ?? 0 });
    }
  }
  return { server: serverName, items: tree.sort((a, b) => a.name.localeCompare(b.name, 'ja')), data: await getDataTree() };
}

const exists = (file) => fs.access(file).then(() => true, () => false);
const parseDt = (text) => ({ tables: yaml.load(text)?.tables ?? [] });
async function readDtWorking(api, level) {
  try {
    return parseDt(await fs.readFile(dtFile(api, level), 'utf8'));
  } catch {
    return null; // ディシジョンテーブルがまだない
  }
}

// ファイルがまだないときは「作業中」の版も出さない
async function getDtVersions(api, level, branch) {
  const versions = await getVersions(dtFile(api, level), branch);
  if (versions.at(-1)?.id === WORKING && !(await exists(dtFile(api, level)))) versions.pop();
  return versions;
}

// 指定したブランチ・版の時点のディシジョンテーブル。ルールが指すケース（id）を解決できるよう、同じ時点のケースの一覧も返す
async function getDt(api, level, v, branch) {
  const { working, hash, text } = await readAt(dtFile(api, level), v, branch);
  let specText;
  try {
    specText = working ? await fs.readFile(filePath(api, level), 'utf8') : await git('show', `${hash}:./${relPath(api, level)}`);
  } catch {
    specText = ''; // その時点にケースのファイルがない
  }
  const cases = (yaml.load(specText)?.cases ?? []).map((c, i) => ({ no: i + 1, id: c.id, title: c.title, status: c.status }));
  return { ...parseDt(text), cases, ...(working ? { etag: etagOf(text) } : {}) };
}

// ディシジョンテーブルを上書きする。読み込んだ後に他で書き換えられていたら止める
async function saveDt(api, level, { etag, tables }) {
  const file = dtFile(api, level);
  const text = await fs.readFile(file, 'utf8');
  if (etagOf(text) !== etag) {
    throw Object.assign(new Error('ファイルが他で変更されています。画面を再読み込みしてください。'), { status: 409 });
  }
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (!Array.isArray(tables)) throw bad('tables が不正です');
  for (const t of tables) {
    if (!t?.id || !String(t.name ?? '').trim()) throw bad('表の名前を入力してください');
    const ids = (t.rules ?? []).map((r) => r?.id);
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw bad(`「${t.name}」のルールの id が不正です`);
  }
  const out = toDtYaml({ ...yaml.load(text), tables });
  await fs.writeFile(file, out);
  return { etag: etagOf(out) };
}

async function filesOf(dir, ext) {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(ext) && NAME.test(f)).sort();
  } catch {
    return [];
  }
}

// テストデータの CSV。先頭の 3 列（id, purpose, cases）は固定で、その後ろに実データと同じ全カラムを並べる
const FIXED = ['id', 'purpose', 'cases'];
const toTable = (file, text) => {
  const [header = FIXED, ...rows] = parseCsv(text);
  const columns = header.slice(FIXED.length);
  const records = rows.map((row) => ({
    id: row[0] ?? '',
    purpose: row[1] ?? '',
    cases: (row[2] ?? '').split(/\s+/).filter(Boolean),
    values: Object.fromEntries(columns.map((c, i) => [c, row[FIXED.length + i] ?? ''])),
  }));
  return { table: file.slice(0, -4), header, rows, columns, records };
};
const readTable = async (level, file) => toTable(file, await fs.readFile(path.join(dataDir, level, file), 'utf8'));
const tableFile = (level, table) => path.join(dataDir, level, `${table}.csv`);

// サイドバー用。テーブルごとに、その下にレベルをまとめる
async function getDataTree() {
  const byTable = new Map();
  for (const level of LEVELS) {
    for (const f of await filesOf(path.join(dataDir, level), '.csv')) {
      const { table, records } = await readTable(level, f);
      if (!byTable.has(table)) byTable.set(table, { table, levels: [] });
      byTable.get(table).levels.push({ level, count: records.length });
    }
  }
  return [...byTable.values()].sort((a, b) => a.table.localeCompare(b.table));
}

// ある時点のレベル内のケース YAML。hash がなければ作業中のファイル、あればそのコミットの時点のもの
async function specFilesAt(level, hash) {
  if (!hash) {
    const files = await filesOf(path.join(specsDir, level), '.yaml');
    return Promise.all(files.map(async (f) => ({ f, text: await fs.readFile(path.join(specsDir, level, f), 'utf8') })));
  }
  const out = await git('ls-tree', '--name-only', hash, `./${level}/`);
  const files = out.split('\n').map((l) => path.basename(l)).filter((f) => f.endsWith('.yaml') && NAME.test(f)).sort();
  return Promise.all(files.map(async (f) => ({ f, text: await git('show', `${hash}:./${level}/${f}`) })));
}

// レベル内のケースを id で引けるようにする。ケースの番号は並び順で決まるので、ファイルには書かない
async function caseIndex(level, hash) {
  const specs = [];
  const byId = new Map();
  for (const { f, text } of await specFilesAt(level, hash)) {
    const spec = yaml.load(text);
    const api = f.slice(0, -5);
    const name = spec.meta?.name || api;
    const cases = (spec.cases ?? []).map((c, i) => ({ no: i + 1, id: c.id, title: c.title, status: c.status }));
    specs.push({ api, name, cases });
    for (const c of cases) byId.set(c.id, { api, name, ...c });
  }
  return { specs, byId };
}

// cases 列のケースの id をケースに解決する。onHit にはケースごとの件数の集計を渡す
const resolveRefs = (records, byId, onHit) =>
  records.map((r) => ({
    ...r,
    refs: r.cases.map((ref) => {
      const c = byId.get(ref);
      if (!c) return { ref, missing: true };
      onHit?.(c);
      return { ref, ...c };
    }),
  }));

// レベル内のテストデータの定義（作業中）。ケース側の表示用に、ケースごとのテーブル別件数も返す
async function getData(level) {
  const { byId } = await caseIndex(level);
  const tables = [];
  const byCase = {};
  for (const f of await filesOf(path.join(dataDir, level), '.csv')) {
    const { table, columns, records } = await readTable(level, f);
    const onHit = (c) => {
      const counts = (byCase[c.id] ??= {});
      counts[table] = (counts[table] ?? 0) + 1;
    };
    tables.push({ table, columns, records: resolveRefs(records, byId, onHit) });
  }
  return { tables, byCase };
}

// 指定したブランチ・版の時点のテーブル。cases 列は同じ時点のケースで解決する
// catalog は「使用しているケース」を選ぶための、同じ時点のケースの一覧。作業中のものは編集の基準にできるよう etag を付ける
async function getDataAt(level, table, v, branch) {
  const { working, hash, text } = await readAt(tableFile(level, table), v, branch);
  const { specs, byId } = await caseIndex(level, working ? null : hash);
  const { columns, records } = toTable(`${table}.csv`, text);
  return { table, columns, records: resolveRefs(records, byId), catalog: specs, ...(working ? { etag: etagOf(text) } : {}) };
}

// テストデータの定義を上書きする。カラムはツールでは変えないので、今のファイルのヘッダーをそのまま使う
// 元のファイルの BOM と改行コードは保つ
async function saveData(level, table, { etag, records }) {
  const file = tableFile(level, table);
  const text = await fs.readFile(file, 'utf8');
  if (etagOf(text) !== etag) {
    throw Object.assign(new Error('ファイルが他で変更されています。画面を再読み込みしてください。'), { status: 409 });
  }
  if (!Array.isArray(records)) throw Object.assign(new Error('records が不正です'), { status: 400 });
  const ids = records.map((r) => String(r.id ?? '').trim());
  if (ids.some((id) => !id)) throw Object.assign(new Error('id が空のレコードがあります'), { status: 400 });
  if (new Set(ids).size !== ids.length) throw Object.assign(new Error('id が重複しています'), { status: 400 });
  const { header, columns } = toTable(`${table}.csv`, text);
  const rows = records.map((r, i) => [ids[i], r.purpose ?? '', (r.cases ?? []).join(' '), ...columns.map((c) => r.values?.[c] ?? '')]);
  let out = stringifyCsv([header, ...rows]);
  if (text.includes('\r\n')) out = out.replaceAll('\n', '\r\n');
  if (text.startsWith('\uFEFF')) out = '\uFEFF' + out;
  await fs.writeFile(file, out);
  return { etag: etagOf(out) };
}

// ファイルを上書きするだけで、コミットは利用者が git で行う。読み込んだ後に別の誰か（エディタなど）が書き換えていたら止める
async function saveSpec(api, level, { etag, cases }) {
  const current = await readWorking(api, level);
  if (current.etag !== etag) {
    throw Object.assign(new Error('ファイルが他で変更されています。画面を再読み込みしてください。'), { status: 409 });
  }
  const text = toYaml({ meta: current.meta, cases });
  await fs.writeFile(filePath(api, level), text);
  return { etag: etagOf(text) };
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleApi(req, res, url) {
  const api = url.searchParams.get('api');
  const level = url.searchParams.get('level');
  const branch = url.searchParams.get('branch');
  if (url.pathname === '/api/tree') return send(res, 200, await getTree());
  if (url.pathname === '/api/branches') return send(res, 200, await getBranches());
  if (url.pathname.startsWith('/api/data')) {
    if (!LEVELS.includes(level)) return send(res, 400, { error: 'level が不正です' });
    if (url.pathname === '/api/data') return send(res, 200, await getData(level));
    const table = url.searchParams.get('table');
    if (!NAME.test(table ?? '')) return send(res, 400, { error: 'table が不正です' });
    // 版の一覧と、指定したブランチ・版の時点のテーブル（一覧・差分の両方で使う）
    if (url.pathname === '/api/data/versions') return send(res, 200, await getVersions(tableFile(level, table), branch));
    if (url.pathname === '/api/data/table' && req.method === 'POST') {
      return send(res, 200, await saveData(level, table, await readBody(req)));
    }
    if (url.pathname === '/api/data/table') {
      const v = url.searchParams.get('v') ?? WORKING;
      if (v !== WORKING && !HASH.test(v)) return send(res, 400, { error: 'v が不正です' });
      return send(res, 200, await getDataAt(level, table, v, branch));
    }
  }
  if (!NAME.test(api ?? '') || !LEVELS.includes(level)) return send(res, 400, { error: 'api または level が不正です' });

  if (url.pathname === '/api/dt/versions') return send(res, 200, await getDtVersions(api, level, branch));
  if (url.pathname === '/api/dt' && req.method === 'POST') return send(res, 200, await saveDt(api, level, await readBody(req)));
  if (url.pathname === '/api/dt') {
    const v = url.searchParams.get('v') ?? WORKING;
    if (v !== WORKING && !HASH.test(v)) return send(res, 400, { error: 'v が不正です' });
    if (v === WORKING && !(await exists(dtFile(api, level)))) return send(res, 200, { tables: [], cases: [], missing: true });
    return send(res, 200, await getDt(api, level, v, branch));
  }
  if (url.pathname === '/api/versions') return send(res, 200, await getVersions(filePath(api, level), branch));
  if (url.pathname === '/api/spec' && req.method === 'GET') {
    const v = url.searchParams.get('v') ?? WORKING;
    if (v !== WORKING && !HASH.test(v)) return send(res, 400, { error: 'v が不正です' });
    return send(res, 200, await readSpec(api, level, v, branch));
  }
  if (url.pathname === '/api/spec' && req.method === 'POST') {
    return send(res, 200, await saveSpec(api, level, await readBody(req)));
  }
  send(res, 404, { error: 'not found' });
}

async function handleStatic(res, url) {
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const full = path.join(publicDir, file);
  if (!full.startsWith(publicDir + path.sep)) return send(res, 404, { error: 'not found' });
  try {
    const body = await fs.readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(res, url);
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`TestSpec: http://localhost:${PORT}\n対象: ${specsDir}`));
