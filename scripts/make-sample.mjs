// fixtures/<サーバー>/<test-specs|test-data>/<レベル>/<名前>/v<n>.yaml から、版ごとにコミットしたサンプルのリポジトリを sample/<サーバー>/ に作る
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { toYaml } from '../lib/yaml.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'fixtures');
const sampleRoot = path.join(root, 'sample');
await fs.rm(sampleRoot, { recursive: true, force: true });

for (const server of await fs.readdir(fixtures)) {
  // 日付順に並べて、1 版ずつコミットする
  const commits = [];
  for (const kind of await fs.readdir(path.join(fixtures, server))) {
    for (const level of await fs.readdir(path.join(fixtures, server, kind))) {
      for (const name of await fs.readdir(path.join(fixtures, server, kind, level))) {
        // テストデータの CSV は版を持たず、そのまま 1 回コミットする
        if (name.endsWith('.csv')) {
          const text = await fs.readFile(path.join(fixtures, server, kind, level, name), 'utf8');
          commits.push({ rel: `${kind}/${level}/${name}`, text, updatedAt: '2026-10-25', changes: 'テストデータ定義を追加', v: 0 });
          continue;
        }
        for (const f of await fs.readdir(path.join(fixtures, server, kind, level, name))) {
          const m = /^v(\d+)\.yaml$/.exec(f);
          if (!m) continue;
          const { updatedAt, changes, ...body } = yaml.load(await fs.readFile(path.join(fixtures, server, kind, level, name, f), 'utf8'));
          commits.push({ rel: `${kind}/${level}/${name}.yaml`, text: toYaml(body), updatedAt, changes, v: Number(m[1]) });
        }
      }
    }
  }
  commits.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.v - b.v);

  const repo = path.join(sampleRoot, server);
  await fs.mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const commit = (message, date) =>
    execFileSync('git', ['-c', 'user.name=sample', '-c', 'user.email=sample@example.com', 'commit', '-q', '-m', message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: `${date}T10:00:00+09:00`, GIT_COMMITTER_DATE: `${date}T10:00:00+09:00` },
    });
  for (const c of commits) {
    await fs.mkdir(path.dirname(path.join(repo, c.rel)), { recursive: true });
    await fs.writeFile(path.join(repo, c.rel), c.text);
    execFileSync('git', ['add', c.rel], { cwd: repo });
    commit(c.changes, c.updatedAt);
  }
  if (server === 'user-service') await makeFeatureBranch(repo, commit);
  console.log(`サンプルを作成しました: ${repo}`);
}

// ブランチの切り替えを試せるように、作業ブランチを 1 本作って main に戻しておく
async function makeFeatureBranch(repo, commit) {
  const git = (...a) => execFileSync('git', a, { cwd: repo });
  git('checkout', '-q', '-b', 'feature/suspended-user');
  const specFile = path.join(repo, 'test-specs/ita/users-get.yaml');
  const spec = yaml.load(await fs.readFile(specFile, 'utf8'));
  spec.cases.push({
    id: '9c4e7a1b-5d2f-4e83-b6a9-3f1d8c0e2b03',
    status: '有効',
    perspective: '異常',
    execution: '自動',
    title: '停止中のユーザーの場合404を返す',
    description: '停止中（deleted_at が入っている）ユーザーを指定した場合、存在しないものとして扱うことを確認する。',
    request: { path: '/users/{停止中のユーザーのUUIDv4}', headers: { Authorization: 'Bearer {管理者のトークン}' } },
    expected: ['ステータスコードが 404 であること', { text: 'レスポンスボディが以下の内容であること', code: { code: 'USER_NOT_FOUND' } }],
    notes: ['admin 権限のユーザーでログインしていること'],
  });
  await fs.writeFile(specFile, toYaml(spec));
  const csvFile = path.join(repo, 'test-data/ita/users.csv');
  const csv = await fs.readFile(csvFile, 'utf8');
  await fs.writeFile(csvFile, csv.replace('取得できないことの確認に使う予定,,', '取得できないことの確認に使う,ユーザー取得API#3,').replace('ユーザー取得API#1 ユーザー取得API#2,', 'ユーザー取得API#1 ユーザー取得API#2 ユーザー取得API#3,'));
  git('add', '.');
  commit('停止中のユーザーを取得した場合のケースを追加', '2026-11-05');
  git('checkout', '-q', 'main');
}
