import { buildCleanedCsv } from './clean.js';
import { attachResultKeyboardNavigation } from './result-keyboard.js';

const $ = (selector) => document.querySelector(selector);

const state = {
  csv: '',
  fileName: 'CSV',
  analysis: null,
  results: new Map(),
  selected: new Set(),
  eol: '\n',
  bom: false,
  running: false,
  finished: false,
  abort: null,
  filter: 'all',
  search: '',
  runId: 0,
  focusedRowIndex: -1
};

const LEVEL_LABELS = {
  ok: 'OK',
  warn: '注意',
  dead: 'リンク切れ',
  error: 'エラー',
  skipped: '対象外',
  pending: '待機'
};

const TYPE_LABELS = {
  wildcard: 'ワイルドカード',
  special: '特殊スキーム',
  private: 'ローカル',
  ip: 'IP',
  invalid: '不正'
};

const FILTERS = [
  { id: 'all', label: 'すべて', test: () => true },
  {
    id: 'problems',
    label: '問題あり',
    test: (_url, result) => ['warn', 'dead', 'error'].includes(result?.level)
  },
  { id: 'error', label: 'エラー', test: (_url, result) => result?.level === 'error' },
  { id: 'dead', label: 'リンク切れ', test: (_url, result) => result?.level === 'dead' },
  { id: 'warn', label: '注意', test: (_url, result) => result?.level === 'warn' },
  { id: 'ok', label: 'OK', test: (_url, result) => result?.level === 'ok' },
  {
    id: 'skipped',
    label: '対象外',
    test: (_url, result) => result?.level === 'skipped'
  },
  { id: 'duplicates', label: '重複', test: (url) => url.isDuplicate }
];

function create(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showAlert(message, kind = 'error') {
  const alert = $('#alert');
  alert.textContent = message;
  alert.className = `alert${kind === 'info' ? ' is-info' : ''}`;
}

function clearAlert() {
  const alert = $('#alert');
  alert.textContent = '';
  alert.className = 'alert hidden';
}

function setFileStatus(message) {
  $('#file-status').textContent = message;
}

function currentOptions() {
  return {
    dns: $('#opt-dns').checked,
    http: $('#opt-http').checked,
    www: $('#opt-www').checked,
    timeoutMs: Number($('#opt-timeout').value),
    concurrency: Number($('#opt-concurrency').value)
  };
}

function levelCounts() {
  const counts = { ok: 0, warn: 0, dead: 0, error: 0, skipped: 0, pending: 0 };
  if (!state.analysis) return counts;

  for (const url of state.analysis.urls) {
    const result = state.results.get(url.id);
    const level = result?.level ?? 'pending';
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

function stat(label, value, tone = '') {
  return create('div', { class: 'stat' }, [
    create('span', { class: 'stat-label', text: label }),
    create('span', {
      class: `stat-value${tone ? ` is-${tone}` : ''}`,
      text: String(value)
    })
  ]);
}

function renderPreview() {
  const analysis = state.analysis;
  if (!analysis) return;

  const summary = analysis.summary;
  const previewStats = $('#preview-stats');
  previewStats.replaceChildren(
    stat('カテゴリ', summary.categories),
    stat('URL 合計', summary.urls),
    stat('チェック対象', summary.checkable),
    stat('重複', `${summary.duplicates} 組`),
    stat('特殊・ワイルドカード', summary.wildcards + summary.special + summary.private),
    stat('形式エラー', summary.invalid)
  );

  const tbody = $('#category-table');
  tbody.replaceChildren(
    ...analysis.categories.map((category) =>
      create('tr', {}, [
        create('td', { text: category.emoji || '—' }),
        create('td', { text: category.color || '—' }),
        create('td', { class: 'numeric', text: category.urlCount }),
        create('td', { class: 'numeric', text: category.line })
      ])
    )
  );

  const issueContainer = $('#preview-issues');
  if (analysis.issues.length === 0) {
    issueContainer.replaceChildren(
      create('p', { class: 'muted', text: '構造エラーはありません。' })
    );
  } else {
    issueContainer.replaceChildren(
      ...analysis.issues.map((issue) =>
        create('div', { class: 'issue' }, [
          create('span', {
            class: `tag ${issue.severity === 'error' ? 'tag-error' : 'tag-warning'}`,
            text: issue.severity === 'error' ? 'エラー' : '注意'
          }),
          create('span', {
            text: issue.sample
              ? `${issue.message} — ${issue.sample}`
              : issue.message
          }),
          create('span', { class: 'line', text: `${issue.line} 行目` })
        ])
      )
    );
  }

  renderIssues();
}

function renderIssues() {
  const analysis = state.analysis;
  const container = $('#issues-content');
  if (!analysis) return;

  const groups = [];

  if (analysis.duplicates.length > 0) {
    groups.push(
      create('section', { class: 'issue-group' }, [
        create('h3', { text: `重複 URL (${analysis.duplicates.length} 組)` }),
        create(
          'ul',
          {},
          analysis.duplicates.map((duplicate) =>
            create('li', {}, [
              create('code', { text: duplicate.key }),
              create(
                'span',
                { class: 'muted' },
                duplicate.occurrences
                  .map(
                    (occurrence) =>
                      ` / ${occurrence.emoji || '—'} (${occurrence.line} 行目)`
                  )
                  .join('')
              )
            ])
          )
        )
      ])
    );
  }

  const specialUrls = analysis.urls.filter((url) =>
    ['wildcard', 'special', 'private', 'ip', 'invalid'].includes(url.type)
  );

  if (specialUrls.length > 0) {
    groups.push(
      create('section', { class: 'issue-group' }, [
        create('h3', {
          text: `自動チェック対象外・特殊 URL (${specialUrls.length} 件)`
        }),
        create(
          'ul',
          {},
          specialUrls.map((url) =>
            create('li', {}, [
              create('span', {
                class: 'tag tag-info',
                text: TYPE_LABELS[url.type] ?? url.type
              }),
              ' ',
              create('code', { text: url.raw }),
              create('span', { class: 'muted', text: ` — ${url.reason}` }),
              create('span', { class: 'muted', text: ` (${url.line} 行目)` })
            ])
          )
        )
      ])
    );
  }

  if (groups.length === 0) {
    container.replaceChildren(
      create('p', { class: 'muted', text: '重複 URL や特殊 URL はありません。' })
    );
    return;
  }

  container.replaceChildren(...groups);
}

function matchesFilter(url, result) {
  const filter = FILTERS.find((item) => item.id === state.filter) ?? FILTERS[0];
  if (!filter.test(url, result)) return false;

  const search = state.search.trim().toLowerCase();
  if (!search) return true;

  return [url.raw, url.host, url.emoji, result?.detail]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}

/** 削除対象としてチェックできる URL かどうか。対象外はチェック不可。 */
function isSelectable(url) {
  return Boolean(url.checkable && url.url);
}

function visibleUrls() {
  if (!state.analysis) return [];
  return state.analysis.urls.filter((url) =>
    matchesFilter(url, state.results.get(url.id))
  );
}

function updateSelectionUi() {
  const count = state.selected.size;
  const countEl = $('#selection-count');
  if (countEl) countEl.textContent = `選択中: ${count}件`;

  const disabled = count === 0;
  const downloadBtn = $('#download-clean');
  const copyBtn = $('#copy-clean');
  if (downloadBtn) downloadBtn.disabled = disabled;
  if (copyBtn) copyBtn.disabled = disabled;

  const selectAll = $('#select-all');
  if (!selectAll) return;

  const targets = visibleUrls().filter(isSelectable);
  const selectedVisible = targets.filter((url) => state.selected.has(url.id)).length;
  selectAll.disabled = targets.length === 0;
  selectAll.checked = targets.length > 0 && selectedVisible === targets.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < targets.length;
}

function addSelection(urls) {
  for (const url of urls) {
    if (isSelectable(url)) state.selected.add(url.id);
  }
  renderResults();
}

function selectProblems() {
  if (!state.analysis) return;
  addSelection(
    state.analysis.urls.filter((url) =>
      ['warn', 'dead', 'error'].includes(state.results.get(url.id)?.level)
    )
  );
}

function clearSelection() {
  state.selected.clear();
  renderResults();
}

function statusCell(result) {
  const level = result?.level ?? 'pending';
  return create('span', {
    class: `status status-${level}`,
    text: LEVEL_LABELS[level] ?? level
  });
}

/** http / https の URL を新しいタブで開けるリンクにする。 */
function urlCell(url) {
  const code = create('code', { text: url.raw });

  if (!url.url) return code;

  let href;
  try {
    const parsed = new URL(url.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return code;
    href = parsed.href;
  } catch {
    return code;
  }

  return create(
    'a',
    {
      class: 'url-link',
      href,
      target: '_blank',
      rel: 'noopener noreferrer',
      title: '新しいタブで開く'
    },
    [code]
  );
}

/** チェックボックスのセル。対象外の URL はチェックできない。 */
function selectionCell(url) {
  if (!isSelectable(url)) {
    return create('td', { class: 'select-cell' }, [
      create('span', { class: 'muted', text: '—' })
    ]);
  }

  const checkbox = create('input', {
    type: 'checkbox',
    class: 'select-row',
    'data-id': url.id,
    'aria-label': `${url.raw} を削除対象にする`,
    checked: state.selected.has(url.id) ? 'checked' : null
  });

  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selected.add(url.id);
    else state.selected.delete(url.id);

    checkbox.closest('tr')?.classList.toggle('is-selected', checkbox.checked);
    updateSelectionUi();
  });

  return create('td', { class: 'select-cell' }, [checkbox]);
}

function renderResults() {
  if (!state.analysis) return;

  const counts = levelCounts();
  const total = state.analysis.urls.length;
  const checked = total - counts.pending;

  const stats = $('#result-stats');
  stats.replaceChildren(
    stat('チェック済み', `${checked} / ${total}`),
    stat('OK', counts.ok, 'ok'),
    stat('注意', counts.warn, 'warn'),
    stat('リンク切れ', counts.dead, 'dead'),
    stat('エラー', counts.error, 'error'),
    stat('対象外', counts.skipped, 'skip')
  );

  const tabs = $('#result-tabs');
  const existingFilter = state.filter;
  tabs.replaceChildren(
    ...FILTERS.map((filter) => {
      const count = state.analysis.urls.filter((url) =>
        filter.test(url, state.results.get(url.id))
      ).length;
      return create('button', {
        type: 'button',
        class: `tab${filter.id === existingFilter ? ' is-active' : ''}`,
        role: 'tab',
        'aria-selected': filter.id === existingFilter ? 'true' : 'false',
        text: `${filter.label} ${count}`,
        onclick: () => {
          state.filter = filter.id;
          renderResults();
        }
      });
    })
  );

  const tbody = $('#result-table');
  const rows = [];

  for (const url of state.analysis.urls) {
    const result = state.results.get(url.id);
    if (!matchesFilter(url, result)) continue;

    const dnsText =
      result?.dns === 'ok'
        ? 'OK'
        : result?.dns === 'fail'
          ? '失敗'
          : result?.dns === 'skipped'
            ? '—'
            : '待機';

    const httpText =
      result?.status !== null && result?.status !== undefined
        ? String(result.status)
        : result?.http === 'fail'
          ? '失敗'
          : result?.http === 'skipped'
            ? '—'
            : '待機';

    const wwwText =
      result?.www === 'ok'
        ? `OK (HTTP ${result.wwwStatus})`
        : result?.www === 'fail'
          ? result.wwwStatus === null
            ? '失敗'
            : `HTTP ${result.wwwStatus}`
          : result?.www === 'skipped'
            ? '—'
            : '待機';

    rows.push(
      create('tr', { class: state.selected.has(url.id) ? 'is-selected' : null }, [
        selectionCell(url),
        create('td', {}, [statusCell(result)]),
        create('td', { class: 'url-cell' }, [
          urlCell(url),
          url.isDuplicate
            ? create('span', {
                class: 'dup-mark',
                text: '重複',
                title: '同じ URL が複数箇所にあります'
              })
            : null
        ]),
        create('td', { text: url.host || '—' }),
        create('td', { text: url.emoji || '—' }),
        create('td', { text: dnsText }),
        create('td', { text: httpText }),
        create('td', {
          class: result?.www === 'ok' ? 'www-ok' : null,
          text: wwwText
        }),
        create('td', { text: result?.detail || url.reason || '—' })
      ])
    );
  }

  tbody.replaceChildren(...rows);
  $('#result-empty').classList.toggle('hidden', rows.length > 0);
  $('#results-card').classList.remove('hidden');
  updateSelectionUi();
}

let lastProgressReport = 0;
const PROGRESS_REPORT_INTERVAL_MS = 150; // アクティブな出力の間隔を抑えて視覚的な跳ね上げを防ぐ

function setProgress(completed, total, counts = null, force = false) {
  const now = Date.now();
  if (!force && state.running && now - lastProgressReport < PROGRESS_REPORT_INTERVAL_MS) {
    return; // アクティブなチェック中に頻繁な更新を抑制する
  }
  lastProgressReport = now;

  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  $('#progress-bar').value = percent;

  const current = counts ?? levelCounts();
  $('#progress-text').textContent =
    `${completed} / ${total} 件をチェック済み — ` +
    `OK ${current.ok ?? 0} / 注意 ${current.warn ?? 0} / ` +
    `リンク切れ ${current.dead ?? 0} / エラー ${current.error ?? 0} / ` +
    `対象外 ${current.skipped ?? 0}`;
}

let renderScheduled = false;
function scheduleResultsRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderResults();
  });
}

async function loadCsv(text, name) {
  if (!text || !text.trim()) {
    showAlert('CSV の内容が空です。');
    return;
  }

  state.abort?.abort();
  state.runId += 1;
  state.csv = text;
  state.fileName = name;
  state.analysis = null;
  state.results.clear();
  state.selected.clear();
  state.eol = text.includes('\r\n') ? '\r\n' : '\n';
  state.bom = text.charCodeAt(0) === 0xfeff;
  state.finished = false;
  state.running = false;
  state.filter = 'all';
  state.search = '';
  $('#search').value = '';
  clearAlert();

  $('#results-card').classList.add('hidden');
  $('#issues-card').classList.add('hidden');
  $('#preview-card').classList.add('hidden');
  $('#options-card').classList.add('hidden');
  $('#progress').classList.add('hidden');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: text })
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'CSV の解析に失敗しました。');
    }

    state.analysis = data.analysis;
    renderPreview();
    $('#preview-card').classList.remove('hidden');
    $('#options-card').classList.remove('hidden');
    $('#issues-card').classList.remove('hidden');
    setFileStatus(`${name} を読み込みました（保存していません）。`);
  } catch (error) {
    state.analysis = null;
    showAlert(error.message);
  }
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    showAlert('ファイルサイズが大きすぎます (最大 4MB)。');
    return;
  }
  const text = await file.text();
  await loadCsv(text, file.name || 'CSV');
}

async function startCheck() {
  if (!state.analysis || state.running) return;

  const options = currentOptions();
  if (!options.dns && !options.http) {
    showAlert('DNS か HTTP のどちらかを有効にしてください。');
    return;
  }

  state.results.clear();
  state.running = true;
  state.finished = false;
  state.abort = new AbortController();
  const runId = ++state.runId;
  clearAlert();

  $('#start-btn').disabled = true;
  $('#cancel-btn').classList.remove('hidden');
  $('#progress').classList.remove('hidden');
  $('#results-card').classList.remove('hidden');
  $('#downloads')
    .querySelectorAll('button')
    .forEach((button) => {
      button.disabled = true;
    });

  setProgress(0, state.analysis.urls.length);
  renderResults();

  try {
    const response = await fetch('/api/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: state.csv, options }),
      signal: state.abort.signal
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `チェックを開始できませんでした (${response.status})`);
    }
    if (!response.body) throw new Error('結果ストリームを受信できませんでした。');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (state.runId !== runId) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) handleEvent(JSON.parse(line), runId);
      }
    }

    if (state.runId === runId && buffer.trim()) {
      handleEvent(JSON.parse(buffer), runId);
    }
  } catch (error) {
    if (state.runId !== runId) return;
    if (error.name === 'AbortError') {
      showAlert('チェックを中止しました。途中までの結果を表示しています。', 'info');
    } else {
      showAlert(`チェックに失敗しました: ${error.message}`);
    }
  } finally {
    if (state.runId === runId) {
      state.running = false;
      state.abort = null;
      $('#start-btn').disabled = false;
      $('#cancel-btn').classList.add('hidden');
      $('#downloads')
        .querySelectorAll('button')
        .forEach((button) => {
          button.disabled = state.results.size === 0;
        });
      renderResults();
    }
  }
}

function handleEvent(event, runId = state.runId) {
  if (runId !== state.runId) return;

  if (event.type === 'analysis') {
    state.analysis = event.analysis;
    renderPreview();
  } else if (event.type === 'start') {
    setProgress(0, event.total);
  } else if (event.type === 'result') {
    state.results.set(event.result.id, event.result);
    setProgress(
      event.progress.completed,
      event.progress.total,
      event.progress.counts
    );
    scheduleResultsRender();
  } else if (event.type === 'done') {
    state.finished = true;
    setProgress(event.progress.completed, event.progress.total, event.progress.counts, true);
    renderResults();
  }
}

function reset() {
  state.abort?.abort();
  state.runId += 1;
  state.csv = '';
  state.fileName = 'CSV';
  state.analysis = null;
  state.results.clear();
  state.selected.clear();
  state.eol = '\n';
  state.bom = false;
  state.running = false;
  state.finished = false;
  state.filter = 'all';
  state.search = '';
  clearAlert();
  showCopyStatus('');
  updateSelectionUi();
  $('#file-input').value = '';
  $('#csv-input').value = '';
  $('#search').value = '';
  setFileStatus('');
  $('#preview-card').classList.add('hidden');
  $('#options-card').classList.add('hidden');
  $('#results-card').classList.add('hidden');
  $('#issues-card').classList.add('hidden');
  $('#progress').classList.add('hidden');
  $('#progress-bar').value = 0;
  $('#progress-text').textContent = '';
}

function buildReport() {
  const counts = levelCounts();
  const urls = state.analysis.urls.map((url) => {
    const result = state.results.get(url.id);
    return {
      id: url.id,
      raw: url.raw,
      type: url.type,
      host: url.host,
      emoji: url.emoji,
      line: url.line,
      isDuplicate: url.isDuplicate,
      duplicateOf: url.duplicateOf,
      dns: result?.dns ?? 'pending',
      dnsAddress: result?.dnsAddress ?? '',
      http: result?.http ?? 'pending',
      status: result?.status ?? null,
      level: result?.level ?? 'pending',
      detail: result?.detail ?? ''
    };
  });

  return {
    tool: 'acid-tabs-checker',
    generatedAt: new Date().toISOString(),
    file: state.fileName,
    options: currentOptions(),
    summary: {
      ...state.analysis.summary,
      results: counts
    },
    urls,
    issues: state.analysis.issues,
    duplicates: state.analysis.duplicates
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function reportCsv(report) {
  const header = [
    'level',
    'url',
    'host',
    'category',
    'line',
    'dns',
    'http_status',
    'duplicate',
    'detail'
  ];
  const rows = report.urls.map((url) => [
    url.level,
    url.raw,
    url.host ?? '',
    url.emoji,
    url.line,
    url.dns,
    url.status ?? '',
    url.isDuplicate ? 'yes' : 'no',
    url.detail
  ]);

  return `\uFEFF${[header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\n')}\n`;
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function reportMarkdown(report) {
  const counts = report.summary.results;
  const lines = [
    '# Acid Tabs CSV チェック結果',
    '',
    `- 実行日時: ${report.generatedAt}`,
    `- ファイル: ${report.file}`,
    `- カテゴリ数: ${report.summary.categories}`,
    `- URL 数: ${report.summary.urls}`,
    `- チェック対象: ${report.summary.checkable}`,
    '',
    '## サマリ',
    '',
    '| 状態 | 件数 |',
    '| --- | ---: |',
    `| OK | ${counts.ok ?? 0} |`,
    `| 注意 | ${counts.warn ?? 0} |`,
    `| リンク切れ | ${counts.dead ?? 0} |`,
    `| エラー | ${counts.error ?? 0} |`,
    `| 対象外 | ${counts.skipped ?? 0} |`,
    `| 未チェック | ${counts.pending ?? 0} |`,
    '',
    '## 問題のある URL',
    '',
    '| 状態 | URL | カテゴリ | 詳細 |',
    '| --- | --- | --- | --- |'
  ];

  const problems = report.urls.filter((url) =>
    ['warn', 'dead', 'error'].includes(url.level)
  );

  if (problems.length === 0) {
    lines.push('| - | 問題はありません | - | - |');
  } else {
    for (const url of problems) {
      lines.push(
        `| ${url.level} | ${mdCell(url.raw)} | ${mdCell(url.emoji)} | ${mdCell(url.detail)} |`
      );
    }
  }

  lines.push('', `## 重複 URL (${report.duplicates.length} 組)`, '');
  if (report.duplicates.length === 0) {
    lines.push('重複はありません。');
  } else {
    for (const duplicate of report.duplicates) {
      lines.push(`- \`${duplicate.key}\``);
      for (const occurrence of duplicate.occurrences) {
        lines.push(
          `  - ${occurrence.emoji || '—'} (${occurrence.line} 行目): ${occurrence.raw}`
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function applyHealthBadge() {
  const badge = $('#privacy-badge');
  if (!badge) return;

  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return;

    const health = await response.json();
    if (health.mode === 'deployed') {
      badge.textContent = '保存しません / 公開環境で実行中';
      badge.classList.add('is-deployed');
      badge.title =
        'CSV はブラウザからこのサーバーへ送信されます。ディスク・DB・ブラウザストレージには保存しません。';
    }
  } catch {
    // 表示の切り替えに失敗してもアプリの動作には影響しない
  }
}

function fileTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

function downloadReport(format) {
  if (!state.analysis || state.results.size === 0) return;

  const report = buildReport();
  const base = `acid-tabs-check_${fileTimestamp()}`;

  if (format === 'json') {
    download(`${base}.json`, JSON.stringify(report, null, 2), 'application/json');
  } else if (format === 'csv') {
    download(`${base}.csv`, reportCsv(report), 'text/csv');
  } else if (format === 'markdown') {
    download(`${base}.md`, reportMarkdown(report), 'text/markdown');
  }
}

function cleanedCsvText() {
  if (!state.analysis) return '';
  return buildCleanedCsv({
    analysis: state.analysis,
    selectedIds: state.selected,
    eol: state.eol,
    bom: state.bom
  });
}

function downloadCleanedCsv() {
  if (!state.analysis || state.selected.size === 0) return;
  download(
    `acid-tabs-cleaned_${fileTimestamp()}.csv`,
    cleanedCsvText(),
    'text/csv;charset=utf-8'
  );
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.className = 'copy-fallback';
  document.body.append(textarea);
  textarea.select();

  const copied = document.execCommand('copy');
  textarea.remove();

  if (!copied) throw new Error('コピーできませんでした');
}

let copyStatusTimer = null;

function showCopyStatus(message, isError = false) {
  const status = $('#copy-status');
  if (!status) return;

  status.textContent = message;
  status.classList.toggle('is-error', isError);
  window.clearTimeout(copyStatusTimer);
  copyStatusTimer = window.setTimeout(() => {
    status.textContent = '';
    status.classList.remove('is-error');
  }, 2500);
}

async function copyCleanedCsv() {
  if (!state.analysis || state.selected.size === 0) return;

  const text = cleanedCsvText();
  const estimatedBytes = new Blob([text]).size;
  const progressSteps = 10;
  const stepIntervalMs = 15;
  let currentStep = 0;
  let timerId = null;

  const updateCopyStatus = () => {
    const pct = progressSteps > 0 ? Math.min(99, Math.round((currentStep / progressSteps) * 100)) : 0;
    showCopyStatus(`コピー中... ${pct}%`, true);
  };

  if (estimatedBytes > 10 * 1024) {
    for (let i = 1; i <= progressSteps; i += 1) {
      currentStep = i;
      updateCopyStatus();
      await new Promise((resolve) => {
        timerId = setTimeout(resolve, stepIntervalMs);
      });
    }
  }
  if (timerId) clearTimeout(timerId);

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    showCopyStatus('コピーしました');
  } catch {
    try {
      fallbackCopy(text);
      showCopyStatus('コピーしました');
    } catch {
      showCopyStatus('コピーできませんでした', true);
    }
  }
}

function init() {
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');

  applyHealthBadge();

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  for (const eventName of ['dragenter', 'dragover']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragover');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  }

  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files?.[0]);
  });

  // ページ外へのドロップでファイルが開かれないようにする
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  $('#sample-btn').addEventListener('click', async () => {
    try {
      const response = await fetch('/sample.csv');
      if (!response.ok) throw new Error('サンプル CSV を取得できませんでした。');
      const text = await response.text();
      await loadCsv(text, 'sample.csv');
    } catch (error) {
      showAlert(error.message);
    }
  });

  $('#paste-btn').addEventListener('click', () => {
    loadCsv($('#csv-input').value, '貼り付け CSV');
  });

  $('#start-btn').addEventListener('click', startCheck);

  $('#cancel-btn').addEventListener('click', () => {
    state.abort?.abort();
  });

  $('#select-problems').addEventListener('click', selectProblems);

  $('#select-visible').addEventListener('click', () => {
    addSelection(visibleUrls());
  });

  $('#clear-selection').addEventListener('click', clearSelection);

  $('#select-all').addEventListener('change', (event) => {
    const targets = visibleUrls().filter(isSelectable);
    for (const url of targets) {
      if (event.target.checked) state.selected.add(url.id);
      else state.selected.delete(url.id);
    }
    renderResults();
  });

  $('#download-clean').addEventListener('click', downloadCleanedCsv);
  $('#copy-clean').addEventListener('click', copyCleanedCsv);

  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderResults();
  });

  $('#downloads').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-format]');
    if (button) downloadReport(button.dataset.format);
  });

  $('#reset-btn').addEventListener('click', reset);

  attachResultKeyboardNavigation($('#result-table'), state);
}

init();
