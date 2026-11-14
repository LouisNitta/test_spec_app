import yaml from 'js-yaml';

// ケース（テストデータはレコード）の間に空行を入れて読みやすくする（git のマージでもケースの境目でぶつかりにくくなる）
export const toYaml = (spec) =>
  yaml
    .dump(spec, { lineWidth: -1, noRefs: true, quotingType: "'" })
    .replace(/\n(  - (?:id|key):)/g, '\n\n$1')
    .replace(/^(cases|records):\n\n/m, '$1:\n');

// ディシジョンテーブル。条件の組み合わせ（when）と結果（then）は 1 行で書き、表の間に空行を入れる
export const toDtYaml = (dt) =>
  yaml
    .dump(dt, { lineWidth: -1, noRefs: true, quotingType: "'", flowLevel: 5 })
    .replace(/\n(  - id:)/g, '\n\n$1')
    // ケースの id は長いので、1 行に 1 つずつ並べる
    .replace(/^( +)cases: \[(.+)\]$/gm, (_, sp, list) => `${sp}cases:\n${list.split(', ').map((id) => `${sp}  - ${id}`).join('\n')}`)
    .replace(/^tables:\n\n/m, 'tables:\n');
