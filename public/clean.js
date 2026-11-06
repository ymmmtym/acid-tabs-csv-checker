/**
 * チェックした URL を除いた Acid Tabs CSV を生成する。
 * DOM に依存しないため、そのままテストできる。
 *
 * 元のカテゴリ順・URL 順を維持し、URL がすべて削除された行は出力しない。
 */
export function buildCleanedCsv({ analysis, selectedIds, eol = '\n', bom = false }) {
  if (!analysis || !Array.isArray(analysis.categories) || !Array.isArray(analysis.urls)) {
    throw new TypeError('analysis with categories and urls is required');
  }

  const selected =
    selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? []);

  const urlsByLine = new Map();
  for (const url of analysis.urls) {
    if (!urlsByLine.has(url.line)) urlsByLine.set(url.line, []);
    urlsByLine.get(url.line).push(url);
  }

  const lines = [];
  for (const category of analysis.categories) {
    const urls = urlsByLine.get(category.line) ?? [];

    // 元から URL がない行は、構造を保つためにそのまま残す
    if (urls.length === 0) {
      lines.push(`${category.emoji}, , ${category.color}`);
      continue;
    }

    const remaining = urls.filter((url) => !selected.has(url.id));
    if (remaining.length === 0) continue;

    const urlColumn = remaining.map((url) => url.raw).join(' ');
    lines.push(`${category.emoji}, ${urlColumn}, ${category.color}`);
  }

  if (lines.length === 0) return bom ? '\uFEFF' : '';
  return `${bom ? '\uFEFF' : ''}${lines.join(eol)}${eol}`;
}
