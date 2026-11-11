import yaml from 'js-yaml';

// ケース（テストデータはレコード）の間に空行を入れて読みやすくする（git のマージでもケースの境目でぶつかりにくくなる）
export const toYaml = (spec) =>
  yaml
    .dump(spec, { lineWidth: -1, noRefs: true, quotingType: '"' })
    .replace(/\n(  - (?:id|key):)/g, '\n\n$1')
    .replace(/^(cases|records):\n\n/m, '$1:\n');
