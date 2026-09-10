// ==UserScript==
// @name         Community Tech Maintenance – Stale Status Watch
// @namespace    https://meta.wikimedia.org/wiki/User:Krlnsbrt
// @version      1.1.0
// @description  Flags rows in the second table on Community_Tech/Maintenance whose "Active Maintenance" status has not changed in over one year (checked against the page's own revision history).
// @author       krlnsbrt
// @license      MIT
// @match        https://meta.wikimedia.org/wiki/Community_Tech/Maintenance*
// @match        https://meta.wikimedia.org/w/index.php?title=Community_Tech/Maintenance*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

/*
 * HOW IT WORKS
 * ------------
 * The maintenance inventory table has NO "last changed" column, so staleness is
 * derived from the wiki page's revision history via the MediaWiki Action API
 * (same origin, no CORS, read-only):
 *
 *   1. Locate the second table on the page (prefers `table.wikitable`).
 *   2. Find the real header row (the table has a grouping row on top of the
 *      actual column headers) and the "Maintenance status" / "Project" columns
 *      by header text.
 *   3. For a few checkpoints in the past (default: ~1, ~2 and ~3 years ago) fetch
 *      the revision that was live on that date, re-render it with action=parse,
 *      and read each project's status from the second table of that old revision.
 *   4. A row is flagged when its CURRENT status is "Active Maintenance" AND the
 *      status was already "Active Maintenance" at the ~1-year checkpoint
 *      (i.e. it has not changed for > 365 days). Older checkpoints only make the
 *      badge say "2yr+" / "3yr+".
 *   5. Flagged rows get a red left bar, a pink background, and a red badge in the
 *      status cell with the tooltip:
 *      "Status unchanged for over 1 year — review needed".
 *
 * DEMO
 * ----
 * Run  CTMaintenanceWatch.runDemo()  from the browser console on any page,
 * or open the bundled  demo.html  file. It builds a mock two-table page with
 * canned history and applies the exact same badging logic – no network needed.
 */

(function () {
  'use strict';

  // ------------------------------------------------------------------ config ---
  const CONFIG = {
    PAGE_TITLE: (window.mw && mw.config && mw.config.get('wgPageName')) || 'Community_Tech/Maintenance',
    API: location.origin + '/w/api.php',
    TABLE_INDEX: 1,                       // second table (0-based)
    STATUS_HEADER_RE: /maintenance\s*status/i,
    PROJECT_HEADER_RE: /^\s*project\s*$/i,
    WATCH_STATUS: 'Active Maintenance',
    ONLY_WATCH_STATUS: true,              // false -> flag ANY status unchanged > 1yr
    CHECKPOINTS_DAYS: [366, 731, 1096],   // ~1yr (required), ~2yr, ~3yr (cosmetic)
    MIN_STALE_DAYS: 365,
    TOOLTIP: 'Status unchanged for over 1 year — review needed',
    DEBUG: false,
  };

  // ------------------------------------------------------------------ utils ----
  const log = (...a) => { if (CONFIG.DEBUG) console.log('[CTMW]', ...a); };
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const key = (s) => norm(s).toLowerCase();

  function injectStyle() {
    if (document.getElementById('ctmw-style')) return;
    const el = document.createElement('style');
    el.id = 'ctmw-style';
    el.textContent = `
      tr.ctmw-flagged { background:#fff0f0 !important; box-shadow: inset 4px 0 0 #d33; }
      tr.ctmw-flagged td, tr.ctmw-flagged th { background:transparent !important; }
      .ctmw-badge {
        display:inline-block; margin-right:.45em; padding:.05em .5em;
        font:bold 11px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;
        color:#fff; background:#d33; border-radius:3px;
        vertical-align:middle; cursor:help; white-space:nowrap;
      }
      .ctmw-panel {
        position:fixed; z-index:99999; right:12px; bottom:12px; max-width:300px;
        background:#fff; color:#222; border:1px solid #d33; border-left:5px solid #d33;
        border-radius:4px; padding:9px 12px;
        font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;
        box-shadow:0 2px 10px rgba(0,0,0,.22);
      }
      .ctmw-panel b { color:#d33; }
      .ctmw-panel button {
        margin-top:7px; font:12px sans-serif; padding:2px 8px; cursor:pointer;
      }
    `;
    (document.head || document.documentElement).appendChild(el);
  }

  function showPanel(count, noteHTML) {
    injectStyle();
    let p = document.querySelector('.ctmw-panel');
    if (!p) {
      p = document.createElement('div');
      p.className = 'ctmw-panel';
      (document.body || document.documentElement).appendChild(p);
    }
    p.innerHTML = '';
    const line = document.createElement('div');
    line.innerHTML = noteHTML
      || ('<b>' + count + '</b> maintenance row' + (count === 1 ? '' : 's')
          + ' unchanged for over 1 year — review needed.');
    p.appendChild(line);
    const btn = document.createElement('button');
    btn.textContent = 'Dismiss';
    btn.addEventListener('click', () => p.remove());
    p.appendChild(btn);
    return p;
  }

  // ---------------------------------------------------------- table helpers ----
  function findTables(root) {
    const wikitables = Array.from(root.querySelectorAll('table.wikitable'));
    return wikitables.length ? wikitables : Array.from(root.querySelectorAll('table'));
  }

  function allRows(table) {
    return Array.from(table.querySelectorAll('tr'));
  }

  // The real header row is the first <tr> that carries a "Maintenance status"
  // cell. This skips any grouping row (colspans) sitting above it.
  function findHeader(table) {
    const rows = allRows(table);
    for (let r = 0; r < rows.length; r++) {
      const cells = Array.from(rows[r].children);
      const statusIdx = cells.findIndex((c) => CONFIG.STATUS_HEADER_RE.test(norm(c.textContent)));
      if (statusIdx >= 0) {
        const projectIdx = cells.findIndex((c) => CONFIG.PROJECT_HEADER_RE.test(norm(c.textContent)));
        return { rowIndex: r, statusIdx, projectIdx, ncols: cells.length };
      }
    }
    return null;
  }

  // Body rows: everything after the header row that has a <td> and at least
  // three cells. (The colspan grouping row above the header is already excluded
  // by slice; three is enough to carry Project + status + one more.)
  function bodyRows(table, header) {
    return allRows(table)
      .slice(header.rowIndex + 1)
      .filter((tr) => tr.querySelector('td') && tr.children.length >= 3);
  }

  // Resolve a header column index against a body row, anchoring from whichever
  // side is closer. The inventory table has gained/lost middle columns over the
  // years (e.g. a revision whose header is missing "Targeted user type" while
  // the body still has that cell), which shifts a left-counted index; "Project"
  // stays 2nd from the left and "Maintenance status" stays last, so anchoring
  // from the near edge keeps both correct across revisions.
  function cellAt(cells, header, colIdx) {
    const fromEnd = header.ncols - 1 - colIdx;
    const idx = fromEnd <= colIdx ? cells.length - 1 - fromEnd : colIdx;
    return cells[idx] || null;
  }

  function readTable(table) {
    const header = findHeader(table);
    if (!header) return null;
    const rows = bodyRows(table, header).map((tr, i) => {
      const cells = Array.from(tr.children);
      const statusCell = cellAt(cells, header, header.statusIdx);
      const projectCell = header.projectIdx >= 0 ? cellAt(cells, header, header.projectIdx) : null;
      return {
        tr,
        i,
        status: statusCell ? norm(statusCell.textContent) : '',
        project: projectCell ? norm(projectCell.textContent) : 'row#' + i,
        statusCell,
      };
    });
    return { header, rows };
  }

  function buildCurrentModel(table) {
    const model = readTable(table);
    if (!model) {
      throw new Error('Could not find a "Maintenance status" column in the second table.');
    }
    return model;
  }

  // --------------------------------------------------------- history via API ---
  async function apiJSON(params) {
    const url = CONFIG.API + '?' + new URLSearchParams(
      Object.assign({ format: 'json', formatversion: '2', origin: '*' }, params)
    );
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error('API HTTP ' + res.status);
    return res.json();
  }

  async function revisionAsOf(daysAgo) {
    const iso = new Date(Date.now() - daysAgo * 864e5).toISOString();
    const data = await apiJSON({
      action: 'query',
      prop: 'revisions',
      titles: CONFIG.PAGE_TITLE,
      rvlimit: '1',
      rvdir: 'older',
      rvstart: iso,
      rvprop: 'ids|timestamp',
    });
    const page = data.query && data.query.pages && data.query.pages[0];
    const rev = page && page.revisions && page.revisions[0];
    return rev ? { oldid: rev.revid, timestamp: rev.timestamp } : null;
  }

  async function statusMapAsOf(daysAgo) {
    const rev = await revisionAsOf(daysAgo);
    if (!rev) return null;
    const data = await apiJSON({ action: 'parse', oldid: String(rev.oldid), prop: 'text' });
    const html = data.parse && data.parse.text;
    if (!html) return null;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = findTables(doc)[CONFIG.TABLE_INDEX];
    if (!table) return null;
    const model = readTable(table);
    if (!model) return null;

    const map = new Map();
    model.rows.forEach((r) => map.set(key(r.project), r.status));
    return { daysAgo, asOf: rev.timestamp, map };
  }

  async function fetchHistory() {
    const snaps = await Promise.all(
      CONFIG.CHECKPOINTS_DAYS.map((d) =>
        statusMapAsOf(d).catch((e) => { log('checkpoint', d, 'failed:', e); return null; })
      )
    );
    return snaps.filter(Boolean).sort((a, b) => a.daysAgo - b.daysAgo);
  }

  // ------------------------------------------------------------- evaluation ----
  // history: ascending by daysAgo. Returns rows whose current status has been
  // unchanged for at least MIN_STALE_DAYS, annotated with `spanDays`.
  function evaluate(model, history) {
    const flagged = [];
    for (const row of model.rows) {
      if (!row.status) continue;
      if (CONFIG.ONLY_WATCH_STATUS && row.status !== CONFIG.WATCH_STATUS) continue;

      let spanDays = 0;
      for (const snap of history) {
        const past = snap.map.get(key(row.project));
        if (past === undefined) break;   // row did not exist that far back
        if (past !== row.status) break;  // status differed -> changed since then
        spanDays = snap.daysAgo;
      }
      if (spanDays > CONFIG.MIN_STALE_DAYS) flagged.push(Object.assign({ spanDays }, row));
    }
    return flagged;
  }

  function badgeRow(row) {
    row.tr.classList.add('ctmw-flagged');
    row.tr.title = CONFIG.TOOLTIP;

    const years = Math.floor(row.spanDays / 365);
    const label = '⚠ ' + (years >= 2 ? years + 'yr+' : '1yr+');

    if (row.statusCell && !row.statusCell.querySelector('.ctmw-badge')) {
      const b = document.createElement('span');
      b.className = 'ctmw-badge';
      b.textContent = label;
      b.title = CONFIG.TOOLTIP;
      row.statusCell.insertBefore(b, row.statusCell.firstChild);
    }
  }

  // ------------------------------------------------------------------- main ----
  async function main() {
    injectStyle();

    const table = findTables(document)[CONFIG.TABLE_INDEX];
    if (!table) { log('second table not found'); return; }

    let model;
    try {
      model = buildCurrentModel(table);
    } catch (e) {
      console.warn('[CTMW]', e.message);
      showPanel(0, '[CTMW] ' + e.message);
      return;
    }

    const candidates = model.rows.filter(
      (r) => !CONFIG.ONLY_WATCH_STATUS || r.status === CONFIG.WATCH_STATUS
    );
    if (!candidates.length) { log('no candidate rows'); return; }

    showPanel(0, '[CTMW] Checking revision history…');

    let history;
    try {
      history = await fetchHistory();
    } catch (e) {
      console.warn('[CTMW]', e);
      showPanel(0, '[CTMW] Could not load revision history: ' + e.message);
      return;
    }
    if (!history.length) {
      showPanel(0, '[CTMW] No historical revisions available to compare.');
      return;
    }

    const flagged = evaluate(model, history);
    flagged.forEach(badgeRow);
    showPanel(flagged.length);
    log('checkpoints:', history.map((h) => h.daysAgo + 'd@' + h.asOf));
    log('flagged:', flagged.map((f) => f.project + ' (' + f.spanDays + 'd)'));
  }

  // ------------------------------------------------------------------- demo ----
  function runDemo() {
    injectStyle();
    try { document.title = 'CTMW demo'; } catch (e) {}

    const host = document.body || document.documentElement;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:16px;font:14px -apple-system,Segoe UI,Roboto,sans-serif;max-width:900px';
    wrap.innerHTML = `
      <h2 style="margin:.2em 0">Community Tech / Maintenance &mdash; userscript demo</h2>
      <p style="color:#555">
        Table&nbsp;1 (status <em>definitions</em>) is ignored. Table&nbsp;2 (the
        inventory) is scanned. With the mock revision history below, two rows have
        held <b>Active Maintenance</b> for over a year and get badged; the others
        do not (status changed within the year, or the row is too new, or it is a
        different status).
      </p>
      <h3 style="margin:.6em 0 .2em">Table 1 &mdash; definitions (ignored)</h3>
      <table class="wikitable" style="border-collapse:collapse" border="1" cellpadding="6"><tbody>
        <tr><th>Status</th><th>Notes</th></tr>
        <tr><td>Active Maintenance</td><td>this is the definitions table &mdash; never scanned</td></tr>
        <tr><td>Passive Maintenance</td><td>&hellip;</td></tr>
      </tbody></table>
      <h3 style="margin:1em 0 .2em">Table 2 &mdash; inventory (scanned)</h3>
      <table class="wikitable" id="ctmw-demo-table" style="border-collapse:collapse" border="1" cellpadding="6"><tbody>
        <tr><td colspan="3"></td></tr>
        <tr><th>Project</th><th>Targeted user type</th><th>Maintenance status</th></tr>
        <tr><td>CopyPatrol</td><td>patrollers</td><td>Active Maintenance</td></tr>
        <tr><td>XTools</td><td>editors</td><td>Active Maintenance</td></tr>
        <tr><td>GlobalWatchlist</td><td>editors</td><td>Active Maintenance</td></tr>
        <tr><td>Popular pages bot</td><td>projects</td><td>Passive Maintenance</td></tr>
        <tr><td>NewProjectTool</td><td>editors</td><td>Active Maintenance</td></tr>
      </tbody></table>
      <p style="color:#555"><small>Return value of <code>runDemo()</code> is logged to the console.</small></p>
    `;
    host.insertBefore(wrap, host.firstChild);

    const model = buildCurrentModel(document.getElementById('ctmw-demo-table'));

    const mk = (pairs) => {
      const m = new Map();
      pairs.forEach(([k, v]) => m.set(key(k), v));
      return m;
    };
    // Mock "status as it was N days ago" snapshots (what the API would return).
    const history = [
      { daysAgo: 366, asOf: 'mock', map: mk([
        ['CopyPatrol', 'Active Maintenance'],
        ['XTools', 'Active Maintenance'],
        ['GlobalWatchlist', 'Active Development'],   // changed within the year -> not flagged
        ['Popular pages bot', 'Passive Maintenance'],
        // NewProjectTool absent -> row too new -> not flagged
      ]) },
      { daysAgo: 731, asOf: 'mock', map: mk([
        ['CopyPatrol', 'Active Maintenance'],
        ['XTools', 'Active Maintenance'],
      ]) },
      { daysAgo: 1096, asOf: 'mock', map: mk([
        ['CopyPatrol', 'Active Maintenance'],        // 3+ years -> "3yr+"
        ['XTools', 'Passive Maintenance'],           // only ~2 years steady -> "2yr+"
      ]) },
    ];

    const flagged = evaluate(model, history);
    flagged.forEach(badgeRow);
    showPanel(flagged.length);

    const summary = flagged.map((f) => ({ project: f.project, unchangedDays: f.spanDays }));
    console.log('[CTMW] demo flagged:', summary);
    return summary;
  }

  // -------------------------------------------------------------- bootstrap ----
  window.CTMaintenanceWatch = { main, runDemo, evaluate, buildCurrentModel, readTable, CONFIG };

  const onTargetPage =
    /(^|\.)meta\.wikimedia\.org$/.test(location.hostname) &&
    /Community_Tech\/Maintenance/.test(decodeURIComponent(location.href));

  function boot() {
    if (/[?&]ctmw-demo=1\b/.test(location.search)) { runDemo(); return; }
    if (onTargetPage) { main(); return; }
    console.log('[CTMW] Not on the target page. Call CTMaintenanceWatch.runDemo() to preview.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
