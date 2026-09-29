/* ==========================================================================
   Babyz Pizza — Revenue & Order Tracker
   Single-page app. Works in three modes:
     server : opened locally AND the local writer (server.js) is running
     draft  : opened locally (file:// or a plain static server) with no writer
     live   : hosted (e.g. GitHub Pages) -> strictly read-only

   THREE data files (managed by server.js):
     MAIN  <Desktop>\Babyz Pizza Data\babyz-data.js        the real local copy
     STAGE <Desktop>\Babyz Pizza Data\babyz-data-pending.js the 2nd local copy
     REPO  <repo>\data\babyz-data.js                        the copy the site reads

   add row      -> MAIN + STAGE + REPO
   delete row   -> STAGE only  (MAIN + REPO untouched)
   undo deletes -> STAGE rebuilt from MAIN
   confirm      -> STAGE pushed into MAIN + REPO
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------ constants */
  var API_PORT = 8787;
  var API_BASE = 'http://127.0.0.1:' + API_PORT;
  var LS_DRAFT = 'babyz.revenue.draft.v2';
  var DATA_URL = 'data/babyz-data.js';

  var COLL_LABEL = {
    offlineOrders: 'Offline order',
    swiggyOrders: 'Swiggy order',
    swiggyPayouts: 'Swiggy weekly payout',
    investments: 'Investment / purchase'
  };

  var COL = {
    orange: '#ff7a18', orangeSoft: 'rgba(255,122,24,.16)',
    amber: '#ffb347', amberSoft: 'rgba(255,179,71,.2)',
    green: '#16a34a', greenSoft: 'rgba(22,163,74,.16)', greenDeep: '#0f5132',
    red: '#e11d48', redSoft: 'rgba(225,29,72,.16)',
    purple: '#7c5cd6', purpleSoft: 'rgba(124,92,214,.16)',
    ink: '#6b6560', inkDeep: '#1b1a19', grid: 'rgba(27,26,25,.08)'
  };

  var CAT_LABEL = { veg: 'Veg', nonveg: 'Non-Veg', combo: 'Combo' };
  var CAT_ORDER = ['veg', 'nonveg', 'combo'];

  var CHANNEL_LABEL = { offline: 'Offline', swiggy: 'Swiggy' };
  /* the four menu groups a item can live in; legacy = off the menu but still
     selectable, so historical orders keep a proper category */
  var MENU_GROUPS = ['veg', 'nonveg', 'combo', 'legacy'];
  var MENU_GROUP_LABEL = { veg: 'Veg', nonveg: 'Non-Veg', combo: 'Combo', legacy: 'Legacy' };

  var state = {
    mode: 'live',
    readOnly: true,  // set at boot from canWrite(); true until proven otherwise
    base: null,      // authoritative data (repo copy + any additions, deletions NOT applied)
    data: null,      // what the page renders = base minus pending deletions
    pending: [],     // staged deletions: [{collection, id, label, row}]
    files: null,
    charts: {},
    draftAvailable: false,
    filters: {
      swiggy: { from: '', to: '', item: '', cat: '', q: '' },
      offline: { from: '', to: '', item: '', cat: '', q: '' }
    }
  };

  /* ------------------------------------------------------------ tiny utils */
  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function inr(n, dec) {
    var d = dec === undefined ? 0 : dec;
    return '\u20B9' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function nf(n, dec) {
    var d = dec === undefined ? 0 : dec;
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function pct(n) { return (Number(n) || 0).toFixed(1) + '%'; }
  function sum(arr, fn) { var t = 0; for (var i = 0; i < arr.length; i++) t += fn ? fn(arr[i]) : arr[i]; return t; }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function todayISO() { return isoDate(new Date()); }

  function dNice(iso) {
    if (!iso) return '\u2014';
    var p = String(iso).split('-');
    if (p.length !== 3) return String(iso);
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.getDate() + ' ' + d.toLocaleDateString('en-IN', { month: 'short' }) + ' ' + d.getFullYear();
  }
  function dShort(iso) {
    if (!iso) return '\u2014';
    var p = String(iso).split('-');
    if (p.length !== 3) return String(iso);
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.getDate() + ' ' + d.toLocaleDateString('en-IN', { month: 'short' });
  }

  /* --------------------------------------------------- calendar weeks (fallback)
     Sunday -> Saturday calendar weeks, with the first week of a month starting
     on the 1st. Sep 2026: W1 1-5, W2 6-12, W3 13-19, W4 20-26, W5 27-30.

     These are NO LONGER how Swiggy weeks are defined \u2014 see weekPeriods() below,
     which follows the payout ranges the user records. They survive for two jobs:
       1. bucketing the offline weekly chart (offline has no payout cycle), and
       2. placing records dated before 1 Sep 2026, where no payout week exists. */
  function weeksInMonth(y, m0) {
    var monthEnd = new Date(y, m0 + 1, 0);
    var out = [], start = new Date(y, m0, 1), idx = 1;
    var guard = 0;
    while (start <= monthEnd && guard++ < 10) {
      var end = new Date(start.getTime());
      end.setDate(start.getDate() + (6 - start.getDay()));
      if (end > monthEnd) end = new Date(monthEnd.getTime());
      out.push({ start: isoDate(start), end: isoDate(end), idx: idx++, y: y });
      start = new Date(end.getTime());
      start.setDate(end.getDate() + 1);
    }
    return out;
  }

  function weekOf(iso) {
    if (!iso) return null;
    var p = String(iso).split('-');
    if (p.length !== 3) return null;
    var ws = weeksInMonth(+p[0], +p[1] - 1);
    for (var i = 0; i < ws.length; i++) if (iso >= ws[i].start && iso <= ws[i].end) return ws[i];
    return null;
  }
  function weekLabel(w) { return w ? ('W' + w.idx + ' \u00B7 ' + dShort(w.start) + '\u2013' + dShort(w.end) + ' ' + w.y) : '\u2014'; }

  /* ------------------------------------------------------------ payout weeks
     The user only picks the START day from a calendar; the end date is derived.
     Every week is 7 days, except the very first week of the tracking period
     (1 Sep 2026), which is the short one. Nothing before 1 Sep 2026 is allowed.
     If a new range overlaps a week already recorded, the two are merged. */
  var WEEK_MIN_START = '2026-09-01';
  var WEEK_FIRST_END = '2026-09-05';
  var WEEK_LEN = 7;

  function addDays(iso, n) {
    var p = String(iso).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return isoDate(d);
  }

  function payoutWeekEnd(startISO) {
    if (!startISO) return '';
    if (startISO === WEEK_MIN_START) return WEEK_FIRST_END;
    return addDays(startISO, WEEK_LEN - 1);
  }

  function daysBetween(a, b) {
    if (!a || !b) return 0;
    return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1;
  }

  function payoutWeekDays(startISO) {
    if (!startISO) return 0;
    return daysBetween(startISO, payoutWeekEnd(startISO));
  }

  function payoutRange(p) {
    var s = p.weekStart || '';
    return { start: s, end: p.weekEnd || payoutWeekEnd(s) };
  }

  function rangesOverlap(a, b) {
    return !!a.start && !!b.start && a.start <= b.end && b.start <= a.end;
  }

  function mergeRanges(a, b) {
    return { start: a.start < b.start ? a.start : b.start, end: a.end > b.end ? a.end : b.end };
  }

  function monthName(iso) {
    return new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
  }

  /* "1\u20135 Sep 2026" or "28 Sep \u2013 4 Oct 2026" */
  function rangeLabel(startISO, endISO) {
    if (!startISO) return '\u2014';
    var end = endISO || payoutWeekEnd(startISO);
    var a = String(startISO).split('-'), b = String(end).split('-');
    if (a[0] === b[0] && a[1] === b[1]) return (+a[2]) + '\u2013' + (+b[2]) + ' ' + monthName(startISO) + ' ' + a[0];
    return (+a[2]) + ' ' + monthName(startISO) + ' \u2013 ' + (+b[2]) + ' ' + monthName(end) + ' ' + b[0];
  }

  /* "1 Sep \u2013 5 Sep 2026" */
  function fullRangeLabel(startISO, endISO) {
    if (!startISO) return '\u2014';
    var end = endISO || payoutWeekEnd(startISO);
    return dShort(startISO) + ' \u2013 ' + dShort(end) + ' ' + String(end).slice(0, 4);
  }

  /* The 7-day grid anchored at 1 Sep 2026, used to place any record that no
     recorded payout week covers: 1\u20135 Sep (the short first block), then
     6\u201312, 13\u201319, 20\u201326, 27 Sep\u20133 Oct, ... Nothing before 1 Sep. */
  function gridWeekOf(iso) {
    if (!iso || iso < WEEK_MIN_START) return null;
    var start = WEEK_MIN_START;
    for (var i = 0; i < 600; i++) {
      var end = payoutWeekEnd(start);
      if (iso >= start && iso <= end) return { start: start, end: end };
      if (start > iso) return null;
      start = addDays(end, 1);
    }
    return null;
  }

  /* Every week the data touches, as one contiguous, sorted list.
     Recorded payout ranges are authoritative \u2014 they define the weeks the user
     actually got paid for, including merged ones. Everything else follows the
     7-day grid anchored at 1 Sep 2026 (1\u20135 Sep is the short first block).
     Dates before 1 Sep 2026 fall back to the plain calendar week, clipped at
     31 Aug so it can never swallow the 1\u20135 Sep week. Weeks with no activity
     are kept, so a quiet week reads as an empty slot rather than a gap.
     Adding N payout rows therefore adds N weeks here \u2014 nothing is hardcoded. */
  function weekPeriods() {
    var segs = [], dates = [];

    function take(iso) { if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) dates.push(iso); }

    state.data.swiggyPayouts.forEach(function (p) {
      var r = payoutRange(p);
      if (r.start && r.end) segs.push({ start: r.start, end: r.end, source: 'payout' });
      take(p.receivedOn);
    });
    state.data.swiggyOrders.forEach(function (o) { take(o.date); });
    state.data.offlineOrders.forEach(function (o) { take(o.date); });
    state.data.investments.forEach(function (i) { take(i.date); });

    dates.sort();
    if (dates.length) {
      var hi = dates[dates.length - 1];
      var start = (weekOf(dates[0]) || {}).start || dates[0];
      for (var guard = 0; guard < 900; guard++) {
        var seg;
        if (start < WEEK_MIN_START) {
          var cw = weekOf(start) || { start: start, end: start };
          seg = { start: cw.start, end: cw.end >= WEEK_MIN_START ? addDays(WEEK_MIN_START, -1) : cw.end };
        } else {
          seg = gridWeekOf(start) || { start: start, end: start };
        }
        if (seg.start > hi) break;
        segs.push({ start: seg.start, end: seg.end, source: 'grid' });
        var next = addDays(seg.end, 1);
        if (next <= start) break;
        start = next;
      }
    }

    segs.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });

    var out = [];
    segs.forEach(function (s) {
      var last = out[out.length - 1];
      if (last && s.start <= last.end) {
        if (s.end > last.end) last.end = s.end;
        if (s.source === 'payout') last.source = 'payout';   /* payout wins the label */
      } else {
        out.push({ start: s.start, end: s.end, source: s.source });
      }
    });
    return out;
  }

  function periodLabel(p) { return p ? rangeLabel(p.start, p.end) : '\u2014'; }

  /* "1\u20135 Sep" \u2014 same as rangeLabel but without the year, for crowded chart axes */
  function shortRangeLabel(startISO, endISO) {
    if (!startISO) return '\u2014';
    var end = endISO || payoutWeekEnd(startISO);
    var a = String(startISO).split('-'), b = String(end).split('-');
    if (a[0] === b[0] && a[1] === b[1]) return (+a[2]) + '\u2013' + (+b[2]) + ' ' + monthName(startISO);
    return (+a[2]) + ' ' + monthName(startISO) + ' \u2013 ' + (+b[2]) + ' ' + monthName(end);
  }

  /* ------------------------------------------------------------ data shape */
  function emptyData() {
    return {
      meta: { version: 1, updatedAt: '', settings: { costPerPizza: 80, applyCostToSwiggy: false } },
      menus: { offline: { veg: [], nonveg: [], combo: [], legacy: [] }, swiggy: { veg: [], nonveg: [], combo: [], legacy: [] } },
      offlineOrders: [], swiggyOrders: [], swiggyPayouts: [], investments: []
    };
  }

  function normalize(d) {
    var base = emptyData();
    d = d || {};
    base.meta = Object.assign({}, base.meta, d.meta || {});
    base.meta.settings = Object.assign({}, emptyData().meta.settings, (d.meta && d.meta.settings) || {});
    delete base.meta.pendingDeletes;
    ['offline', 'swiggy'].forEach(function (ch) {
      base.menus[ch] = Object.assign({ veg: [], nonveg: [], combo: [], legacy: [] }, (d.menus && d.menus[ch]) || {});
    });
    ['offlineOrders', 'swiggyOrders', 'swiggyPayouts', 'investments'].forEach(function (k) {
      base[k] = Array.isArray(d[k]) ? d[k].slice() : [];
    });
    return base;
  }

  function settings() { return state.data.meta.settings; }

  /* ------------------------------------------------------------ mode + load */
  /* WRITE GATE. Only two kinds of page may ever add or delete anything:
       1. a page opened straight off disk  (file://), or
       2. a page served by the local writer (localhost / 127.0.0.1 / ::1).
     Anything else \u2014 GitHub Pages, any other host \u2014 is read-only, with no
     query-string switch to opt out. There is deliberately NO ?local=1 escape
     hatch: it would let a hosted URL turn its own add/delete controls back on. */
  var LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

  function isLocalContext() {
    if (location.protocol === 'file:') return true;
    var h = (location.hostname || '').toLowerCase();
    if (LOCAL_HOSTS.indexOf(h) >= 0) return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;   /* any 127.x loopback */
    if (/\.localhost$/.test(h)) return true;
    return false;
  }

  /* The single gate every mutation must pass. Checked live (not just at boot),
     so a page can never talk itself into a writing mode. */
  function canWrite() {
    return isLocalContext() && (state.mode === 'server' || state.mode === 'draft');
  }

  function guardWrite() {
    if (canWrite()) return true;
    readOnlyWarn();
    return false;
  }

  function probeWriter() {
    return fetch(API_BASE + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function fetchState() {
    return fetch(API_BASE + '/api/state', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /* live mode: the page reads the repo copy */
  function fetchRepoCopy() {
    return fetch(DATA_URL + '?v=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (txt) {
        if (!txt) return null;
        var i = txt.indexOf('{'), j = txt.lastIndexOf('}');
        if (i < 0 || j < 0) return null;
        return JSON.parse(txt.slice(i, j + 1));
      })
      .catch(function () { return null; });
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(LS_DRAFT) || localStorage.getItem('babyz.revenue.draft.v1');
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (d && d.data) return d;                       // v2 shape
      return { data: d, pending: [] };                 // v1 shape
    } catch (e) { return null; }
  }

  function applyPending() {
    state.pending.forEach(function (p) {
      if (state.data[p.collection]) {
        state.data[p.collection] = state.data[p.collection].filter(function (r) { return r.id !== p.id; });
      }
    });
  }

  function boot() {
    var local = isLocalContext();

    var step = local
      ? fetchState().then(function (st) {
        if (st && st.ok) return { writer: true, st: st, base: st.base, pending: st.pending || [], files: st.files };
        return fetchRepoCopy().then(function (d) { return { writer: false, base: d, pending: [], files: null }; });
      })
      : fetchRepoCopy().then(function (d) { return { writer: false, base: d, pending: [], files: null, live: true }; });

    step.then(function (r) {
      if (local && r.writer) {
        state.mode = 'server';
        state.files = r.files;
        state.base = normalize(r.base);
        state.pending = Array.isArray(r.pending) ? r.pending : [];
      } else if (local) {
        state.mode = 'draft';
        var draft = loadDraft();
        if (draft) { state.draftAvailable = true; }
        state.base = normalize(draft ? draft.data : r.base);
        state.pending = (draft && Array.isArray(draft.pending)) ? draft.pending : [];
      } else {
        state.mode = 'live';
        state.base = normalize(r.base || window.BABYZ_DATA || null);
        state.pending = [];
      }

      state.data = clone(state.base);
      applyPending();

      /* read-only whenever this page is not allowed to write \u2014 which on a hosted
         site is always. Drives every .readonly-hide control. */
      state.readOnly = !canWrite();
      document.body.classList.toggle('is-live', state.readOnly);
      document.body.classList.toggle('is-readonly', state.readOnly);
      renderHeader();
      renderBanner();
      renderSettings();
      renderAll();
      wireEvents();

      if (state.pending.length) {
        toast(state.pending.length + ' staged deletion(s) restored from the 2nd local copy.', '');
      }
    }).catch(function (err) {
      console.error(err);
      state.base = normalize(window.BABYZ_DATA || null);
      state.data = clone(state.base);
      renderHeader(); renderBanner(); renderSettings(); renderAll(); wireEvents();
    });
  }

  /* ------------------------------------------------------------ persist */
  function postJSON(pathname, body) {
    return fetch(API_BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: e.message }; });
  }

  function readOnlyWarn() {
    toast('Read-only: this hosted copy cannot be edited. Open the site locally to add, edit or delete rows.', 'err');
  }

  /* A failed write must not be a 3-second toast the user can miss. Until it
     succeeds the change lives only in this browser tab, and if the write got as
     far as writing the .tmp file the new copy is sitting on disk unrenamed.
     So show the real error in the modal, which stays until dismissed. */
  function saveFailed(what, res) {
    var raw = (res && res.error) || 'unknown error';
    var hint = '';
    if (/EPERM|EACCES|EBUSY/i.test(raw)) {
      hint = 'Another program is holding the data file open, so Windows would not let it be ' +
        'replaced. This is usually an editor with the file open (Zed, VS Code), OneDrive, ' +
        'antivirus, or the Explorer preview pane.<br><br>Close that program and save again. ' +
        '<b>Nothing has been lost</b>: the new data was written next to the real file as ' +
        '<code>babyz-data.js.tmp</code>.';
    } else if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
      hint = 'The local writer is not reachable. Start it with <code>node server.js</code> ' +
        '(or <code>start-local.bat</code>) and save again.';
    } else {
      hint = 'The change is still only in this browser tab and has <b>not</b> been written to disk.';
    }
    openModal({
      tone: 'danger',
      icon: '\u26A0\uFE0F',
      title: what + ' failed',
      message: '<code>' + esc(raw).replace(/\n/g, '<br>') + '</code>',
      detail: hint,
      confirmText: 'Close',
      confirmClass: 'btn-primary',
      hideCancel: true,
      onConfirm: null
    });
  }

  function saveDraft() {
    try {
      localStorage.setItem(LS_DRAFT, JSON.stringify({ data: state.base, pending: state.pending }));
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve({ ok: false, error: 'browser storage is full' });
    }
  }

  /* add / settings change -> MAIN + STAGE + REPO */
  function writeAll(okMsg) {
    if (!guardWrite()) return Promise.resolve({ ok: false });
    if (state.mode === 'draft') return saveDraft();
    return postJSON('/api/rows', { data: state.base, view: state.data, pending: state.pending })
      .then(function (res) {
        if (res && res.ok) toast(okMsg || 'Saved to all 3 files (main local + 2nd local copy + repo copy).', 'ok');
        else saveFailed('Save', res);
        return res || { ok: false };
      });
  }

  /* delete -> STAGE only */
  function writeStage() {
    if (!guardWrite()) return Promise.resolve({ ok: false });
    if (state.mode === 'draft') return saveDraft();
    return postJSON('/api/stage', { view: state.data, pending: state.pending })
      .then(function (res) {
        if (!res || !res.ok) saveFailed('Delete', res);
        return res || { ok: false };
      });
  }

  function doUndo() {
    if (!guardWrite()) return;
    if (state.mode === 'draft') {
      state.pending = [];
      state.data = clone(state.base);
      saveDraft().then(renderAll);
      toast('Deletes undone.', 'ok');
      return;
    }
    postJSON('/api/undo', {}).then(function (res) {
      if (!res || !res.ok) { saveFailed('Undo', res); return; }
      state.base = normalize(res.base);
      state.data = clone(state.base);
      state.pending = [];
      renderAll();
      toast('Deletes undone \u2014 restored from the main local file.', 'ok');
    });
  }

  function doConfirm() {
    if (!guardWrite()) return;
    if (state.mode === 'draft') {
      state.base = clone(state.data);
      state.pending = [];
      saveDraft().then(renderAll);
      toast('Deletions confirmed locally.', 'ok');
      return;
    }
    postJSON('/api/confirm', {}).then(function (res) {
      if (!res || !res.ok) { saveFailed('Confirm delete', res); return; }
      state.base = normalize(res.base);
      state.data = clone(state.base);
      state.pending = [];
      renderAll();
      toast((res.applied || 0) + ' deletion(s) pushed to the main local file and the repo copy.', 'ok');
    });
  }

  function addRow(collection, row) {
    if (!guardWrite()) return;
    state.base[collection] = state.base[collection].concat([row]);
    state.data[collection] = state.data[collection].concat([row]);
    writeAll().then(function (res) { if (res && res.ok) renderAll(); });
  }

  /* ------------------------------------------------------------ describe a row */
  function describeRow(collection, row) {
    if (!row) return '';
    if (collection === 'offlineOrders') {
      var oLines = rowLines(row, 'offline');
      return (linesLabel(oLines)) + ' \u00B7 ' + dNice(row.date) + ' \u00B7 ' + (row.customer || '\u2014') +
        ' \u00B7 ' + inr(sum(oLines, function (l) { return l.qty * l.price; }) - (+row.offerAmount || 0));
    }
    if (collection === 'swiggyOrders') {
      var sLines = rowLines(row, 'swiggy');
      return (row.orderNo ? '#' + row.orderNo + ' \u00B7 ' : '') +
        (linesLabel(sLines)) + ' \u00B7 ' + dNice(row.date) + ' \u00B7 ' + (row.customer || '\u2014') +
        ' \u00B7 ' + inr(sum(sLines, function (l) { return l.qty * l.price; }));
    }
    if (collection === 'swiggyPayouts') {
      var r = payoutRange(row);
      return 'Week ' + fullRangeLabel(r.start, r.end) + ' (' + daysBetween(r.start, r.end) + ' days) \u00B7 payout ' +
        inr(+row.payout || 0, 2) +
        ((+row.mergedFrom || 1) > 1 ? ' \u00B7 merged from ' + row.mergedFrom + ' entries' : '');
    }
    if (collection === 'investments') {
      return (row.item || '') + ' \u00B7 ' + (row.date ? dNice(row.date) : (row.dateLabel || '\u2014')) +
        ' \u00B7 ' + inr(+row.amount || 0);
    }
    return row.id || '';
  }

  /* ------------------------------------------------------------ toast */
  function toast(msg, kind) {
    var host = $('toast-host');
    if (!host) return;
    var t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      setTimeout(function () { t.remove(); }, 320);
    }, 3600);
  }

  /* ------------------------------------------------------------ modal */
  var modalConfirmFn = null;

  function openModal(opts) {
    var bd = $('modalBackdrop');
    var box = bd.querySelector('.modal');
    box.className = 'modal ' + (opts.tone || '');
    $('modalIcon').textContent = opts.icon || '\uD83D\uDDD1\uFE0F';
    $('modalTitle').textContent = opts.title || 'Are you sure?';
    $('modalMsg').innerHTML = opts.message || '';
    $('modalDetail').innerHTML = opts.detail || '';
    var ok = $('modalOk');
    ok.textContent = opts.confirmText || 'Confirm';
    ok.className = 'btn ' + (opts.confirmClass || 'btn-primary');
    /* an editor that disables the confirm button until its fields are valid
       (the order no. and investment editors) must not leave it disabled for the
       NEXT popup \u2014 nothing else clears this flag, so clear it on every open */
    ok.disabled = false;
    /* an error notice has nothing to cancel - hide the ghost button */
    $('modalCancel').hidden = !!opts.hideCancel;
    modalConfirmFn = opts.onConfirm || null;
    bd.hidden = false;
    setTimeout(function () { ok.focus(); }, 40);
  }

  function closeModal() {
    $('modalBackdrop').hidden = true;
    modalConfirmFn = null;
  }

  /* ------------------------------------------------------------ delete flow */
  function requestDelete(collection, id) {
    if (!guardWrite()) return;
    var row = (state.data[collection] || []).filter(function (r) { return r.id === id; })[0];
    if (!row) return;
    openModal({
      tone: 'danger',
      icon: '\uD83D\uDDD1\uFE0F',
      title: 'Are you sure you want to delete this row?',
      message: 'It is removed from the <b>2nd local copy</b> right away. ' +
        'The main local file and the repo copy stay untouched until you press <b>Confirm delete</b>.',
      detail: '<b>' + esc(COLL_LABEL[collection] || collection) + '</b><br>' + esc(describeRow(collection, row)),
      confirmText: 'Yes, delete row',
      confirmClass: 'btn-solid-danger',
      onConfirm: function () {
        state.pending.push({
          collection: collection, id: id,
          label: COLL_LABEL[collection] + ': ' + describeRow(collection, row),
          row: row
        });
        state.data[collection] = state.data[collection].filter(function (r) { return r.id !== id; });
        writeStage().then(function (res) { if (res && res.ok) renderAll(); });
      }
    });
  }

  function requestConfirmDeletes() {
    var n = state.pending.length;
    if (!n) return;
    openModal({
      tone: 'ok',
      icon: '\u2705',
      title: 'Confirm delete',
      message: 'Push <b>' + n + '</b> staged deletion' + (n === 1 ? '' : 's') +
        ' from the 2nd local copy into the <b>main local file</b> and the <b>repo copy</b>?<br>' +
        'After this, commit &amp; push the repo copy to publish the change.',
      detail: state.pending.map(function (p) { return esc(p.label); }).join('<br>'),
      confirmText: 'Yes, confirm delete',
      confirmClass: 'btn-confirm',
      onConfirm: doConfirm
    });
  }

  /* ------------------------------------------------------------ customer name */
  /* Renaming a customer is a normal save, not a staged delete: the corrected name
     goes to the MAIN local file, the 2nd local copy and the repo copy in one go,
     through the same /api/rows path an added row uses. */

  var EDITABLE_CUSTOMER = { offlineOrders: 1, swiggyOrders: 1 };

  /* a raw row is the one on disk; the table renders a computed copy of it, so we
     look the row up in state.data (what is on screen) to pre-fill the input */
  function rawOrderRow(collection, id) {
    var list = (state.data && state.data[collection]) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }

  function customerPlaceholder(collection, row) {
    if (row && row.customer) return row.customer;
    return collection === 'swiggyOrders' ? 'Random' : 'Walk-in';
  }

  function requestCustomerEdit(collection, id) {
    if (!guardWrite()) return;
    if (!EDITABLE_CUSTOMER[collection]) return;
    var row = rawOrderRow(collection, id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var current = String(row.customer || '');
    var who = COLL_LABEL[collection] || collection;

    openModal({
      tone: 'edit',
      icon: '\u270F\uFE0F',
      title: 'Edit the customer name',
      message: 'Saving writes the corrected name to the <b>main local file</b>, the <b>2nd local copy</b> and the ' +
        '<b>repo copy</b>, and every table, filter and chart refreshes straight away.',
      detail: '<b>' + esc(who) + '</b> \u00B7 ' + esc(row.item || '') + ' \u00B7 ' + dNice(row.date) + '<br>' +
        esc(describeRow(collection, row)) +
        '<div class="modal-form"><label for="customerEditInput">Customer name</label>' +
        '<input type="text" id="customerEditInput" autocomplete="off" spellcheck="false" maxlength="80" value="' +
          esc(current) + '" placeholder="' + esc(customerPlaceholder(collection, row)) + '"></div>',
      confirmText: 'Save name',
      confirmClass: 'btn-primary',
      onConfirm: function () {
        var el = $('customerEditInput');
        if (!el) return;
        applyCustomerName(collection, id, el.value);
      }
    });

    /* pre-select the whole name so typing replaces it, and let Enter save */
    var input = $('customerEditInput');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        $('modalOk').click();
      });
    }
  }

  /* -> both copies, then all 3 files, then a pop-up confirming the save */
  function applyCustomerName(collection, id, raw) {
    if (!guardWrite()) return;
    var row = rawOrderRow(collection, id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var before = String(row.customer || '');
    var after = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!after) after = customerPlaceholder(collection, row);

    if (after === before) {
      toast('Customer name unchanged \u2014 nothing was written.', '');
      return;
    }

    /* state.base is what gets written to the files, state.data is what renders.
       Mutating only one of them either saves nothing or shows nothing. */
    var touched = 0;
    ['base', 'data'].forEach(function (which) {
      var list = (state[which] && state[which][collection]) || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        if (which === 'base') touched++;
        var next = Object.assign({}, list[i]);   /* a fresh object per copy, never shared */
        next.customer = after;
        list[i] = next;
      }
    });
    if (!touched) { toast('That order is not in the loaded data any more.', 'err'); return; }

    writeAll('Customer name saved to all 3 files: "' + before + '" \u2192 "' + after + '".')
      .then(function (res) {
        if (res && res.ok) {
          renderAll();
          openModal({
            tone: 'ok',
            icon: '\u2705',
            title: 'Customer name saved',
            message: 'Written to the <b>main local file</b>, the <b>2nd local copy</b> and the <b>repo copy</b>. ' +
              'Commit &amp; push the repo copy to publish it to the live site.',
            detail: esc(COLL_LABEL[collection] || collection) + ' \u00B7 ' + esc(row.item || '') +
              '<br>"' + esc(before) + '" \u2192 <b>"' + esc(after) + '"</b>',
            confirmText: 'Done',
            confirmClass: 'btn-confirm'
          });
        }
      });
  }

  /* ------------------------------------------------------- swiggy order no. */
  /* Adds a number to a row that has none, or changes the one it has. Stored
     without the hash; the table, describeRow and the invoice all render it as
     #XXXX. Blank is allowed and removes the number. Same three-file save. */
  function requestOrderNoEdit(id) {
    if (!guardWrite()) return;
    var row = rawOrderRow('swiggyOrders', id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var current = String(row.orderNo || '');

    openModal({
      tone: 'edit',
      icon: '\u270F\uFE0F',
      title: current ? 'Edit the Swiggy order number' : 'Add a Swiggy order number',
      message: 'Saving writes it to the <b>main local file</b>, the <b>2nd local copy</b> and the ' +
        '<b>repo copy</b>, and it shows up in the Order no. column and on the invoice straight away.',
      detail: '<b>' + esc(COLL_LABEL.swiggyOrders) + '</b> \u00B7 ' + esc(row.item || '') + ' \u00B7 ' + dNice(row.date) +
        '<div class="modal-form"><label for="orderNoEditInput">Order number</label>' +
        '<input type="text" id="orderNoEditInput" autocomplete="off" spellcheck="false" inputmode="numeric" ' +
          'maxlength="5" placeholder="#1234" value="' + esc(current ? '#' + current : '') + '">' +
        '<div class="modal-hint">Format <b>#XXXX</b> \u2014 four digits. Leave it blank to remove the number.</div></div>',
      confirmText: current ? 'Save number' : 'Add number',
      confirmClass: 'btn-primary',
      onConfirm: function () { applyOrderNo(id, current); }
    });

    var input = $('orderNoEditInput'), ok = $('modalOk');
    if (!input || !ok) return;

    /* keep the button off while the field is not a valid #XXXX, so a bad number
       can never reach the files */
    input.addEventListener('input', function () { ok.disabled = !normalizeOrderNo(input.value).ok; });
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (!ok.disabled) ok.click();
    });

    /* openModal focuses the confirm button 40ms after opening, so claim focus
       back afterwards rather than fighting it */
    setTimeout(function () { input.focus(); input.select(); }, 60);
  }

  /* -> both copies, then all 3 files, then a pop-up confirming the save */
  function applyOrderNo(id, before) {
    if (!guardWrite()) return;
    var row = rawOrderRow('swiggyOrders', id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var input = $('orderNoEditInput');
    if (!input) return;
    var norm = normalizeOrderNo(input.value);
    if (!norm.ok) {
      toast('Order no. must be # followed by exactly 4 digits (e.g. #1234) \u2014 or leave it blank.', 'err');
      return;
    }
    var after = norm.value;

    if (after === before) {
      toast('Order number unchanged \u2014 nothing was written.', '');
      return;
    }

    /* state.base is what gets written to the files, state.data is what renders.
       Mutating only one of them either saves nothing or shows nothing. */
    var touched = 0;
    ['base', 'data'].forEach(function (which) {
      var list = (state[which] && state[which].swiggyOrders) || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        if (which === 'base') touched++;
        var next = Object.assign({}, list[i]);   /* a fresh object per copy, never shared */
        next.orderNo = after;
        list[i] = next;
      }
    });
    if (!touched) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var was = before ? '#' + before : '(none)';
    var now = after ? '#' + after : '(none)';
    writeAll(after
        ? 'Order number saved to all 3 files: ' + now + '.'
        : 'Order number removed from all 3 files.')
      .then(function (res) {
        if (res && res.ok) {
          renderAll();
          openModal({
            tone: 'ok',
            icon: '\u2705',
            title: after ? 'Order number saved' : 'Order number removed',
            message: 'Written to the <b>main local file</b>, the <b>2nd local copy</b> and the <b>repo copy</b>. ' +
              'Commit &amp; push the repo copy to publish it to the live site.',
            detail: esc(COLL_LABEL.swiggyOrders) + ' \u00B7 ' + esc(row.item || '') + ' \u00B7 ' + dNice(row.date) +
              '<br>' + esc(was) + ' \u2192 <b>' + esc(now) + '</b>',
            confirmText: 'Done',
            confirmClass: 'btn-confirm'
          });
        }
      });
  }

  /* ------------------------------------------------------- order items edit */
  /* Change the pizzas on an order: add another, change a qty or a price, or drop
     one. Same shape as every other row editor \u2014 open a popup, validate, mutate
     BOTH state.base and state.data with a fresh object per copy, writeAll(), then
     a ✅ confirmation popup. */
  var EDITABLE_ITEMS = { offlineOrders: 1, swiggyOrders: 1 };

  function requestItemsEdit(collection, id) {
    if (!guardWrite()) return;
    if (!EDITABLE_ITEMS[collection]) return;
    var row = rawOrderRow(collection, id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var channel = collection === 'swiggyOrders' ? 'swiggy' : 'offline';
    var before = rowLines(row, channel);

    openModal({
      tone: 'edit',
      icon: '\u270F\uFE0F',
      title: 'Edit the pizzas on this order',
      message: 'Saving writes the order to the <b>main local file</b>, the <b>2nd local copy</b> and the ' +
        '<b>repo copy</b>, and the totals, charts and invoice refresh straight away.',
      detail: '<b>' + esc(COLL_LABEL[collection]) + '</b> \u00B7 ' + esc(describeRow(collection, row)) +
        '<div class="modal-form">' +
          '<label>Pizzas on this order</label>' +
          '<div class="lines-editor" id="itemsEditLines">' +
            '<div class="lines-body"></div>' +
            '<div class="lines-foot">' +
              '<button type="button" class="btn btn-ghost btn-sm line-add">\u2795 Add another pizza</button>' +
              '<span class="lines-total"></span>' +
            '</div>' +
          '</div>' +
          (channel === 'offline'
            ? '<div class="modal-form-row"><div><label for="itemsEditOffer">Offer amount (\u20B9) \u00B7 whole order</label>' +
              '<input type="number" id="itemsEditOffer" min="0" step="1" value="' + (+row.offerAmount || 0) + '"></div></div>'
            : '') +
          '<div class="modal-hint">Each pizza prints as its own line on the invoice. The same pizza at the same price is kept as one line.</div>' +
        '</div>',
      confirmText: 'Save items',
      confirmClass: 'btn-primary',
      onConfirm: function () { applyItemsEdit(collection, id, before); }
    });

    var root = $('itemsEditLines');
    renderLinesEditor(root, channel, before);
    wireLinesEditor(root);
  }

  /* -> both copies, then all 3 files, then a pop-up confirming the save */
  function applyItemsEdit(collection, id, before) {
    if (!guardWrite()) return;
    var row = rawOrderRow(collection, id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var channel = collection === 'swiggyOrders' ? 'swiggy' : 'offline';
    var picked = readLinesEditor($('itemsEditLines'));
    if (!picked.ok) { toast(picked.error, 'err'); return; }

    var after = picked.lines;
    var offerEl = $('itemsEditOffer');
    var offer = offerEl ? (parseFloat(offerEl.value) || 0) : null;

    /* nothing changed -> say so rather than writing the files for no reason */
    var same = after.length === before.length;
    if (same) {
      for (var i = 0; i < after.length; i++) {
        if (after[i].item !== before[i].item || after[i].qty !== before[i].qty ||
            after[i].price !== before[i].price) { same = false; break; }
      }
    }
    if (same && (offer === null || offer === (+row.offerAmount || 0))) {
      toast('Nothing changed \u2014 nothing was written.', '');
      return;
    }

    var touched = 0;
    ['base', 'data'].forEach(function (which) {
      var list = (state[which] && state[which][collection]) || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        if (which === 'base') touched++;
        /* a fresh object per copy, and fresh line objects \u2014 never share a
           reference between the two state copies */
        var next = Object.assign({}, list[i], linesSummary(after, channel), {
          lines: after.map(function (l) { return { item: l.item, qty: l.qty, price: l.price }; })
        });
        if (channel === 'swiggy') next.sellingPrice = after[0].price;
        else { next.rate = after[0].price; next.offer = offer > 0; next.offerAmount = offer; }
        list[i] = next;
      }
    });
    if (!touched) { toast('That order is not in the loaded data any more.', 'err'); return; }

    var wasUnits = sum(before, function (l) { return l.qty; });
    var nowUnits = sum(after, function (l) { return l.qty; });
    writeAll('Order updated in all 3 files.')
      .then(function (res) {
        if (!res || !res.ok) return;
        renderAll();
        openModal({
          tone: 'ok',
          icon: '\u2705',
          title: 'Order updated',
          message: 'Written to the <b>main local file</b>, the <b>2nd local copy</b> and the <b>repo copy</b>. ' +
            'Commit &amp; push the repo copy to publish it to the live site.',
          detail: esc(COLL_LABEL[collection]) + ' \u00B7 ' + dNice(row.date) + '<br>' +
            esc(linesLabel(before)) + ' \u2192 <b>' + esc(linesLabel(after)) + '</b>' +
            '<br>' + nf(wasUnits) + ' \u2192 <b>' + nf(nowUnits) + '</b> pizza' + (nowUnits === 1 ? '' : 's'),
          confirmText: 'Done',
          confirmClass: 'btn-confirm'
        });
      });
  }

  /* ------------------------------------------------------- investment edit */
  /* qty, rate and amount are editable together. The amount follows qty x rate
     while you type, but stays editable on its own so a one-off figure can be
     entered directly (e.g. a round-numbered bill). Same three-file save as
     every other edit: both state copies, then /api/rows, then a confirmation. */
  function requestInvestmentEdit(id) {
    if (!guardWrite()) return;
    var row = rawOrderRow('investments', id);
    if (!row) { toast('That investment is not in the loaded data any more.', 'err'); return; }

    var before = { qty: +row.qty || 0, rate: +row.rate || 0, amount: +row.amount || 0 };

    openModal({
      tone: 'edit',
      icon: '\u270F\uFE0F',
      title: 'Edit this investment',
      message: 'Saving writes the new figures to the <b>main local file</b>, the <b>2nd local copy</b> and the ' +
        '<b>repo copy</b>, and every table and total refreshes straight away.',
      detail: '<b>' + esc(row.item || '') + '</b> \u00B7 ' + dNice(row.date) +
        '<div class="modal-form"><div class="modal-form-row">' +
          '<div><label for="invEditQty">Qty</label>' +
            '<input type="number" id="invEditQty" min="0" step="any" value="' + before.qty + '"></div>' +
          '<div><label for="invEditRate">Rate (\u20B9)</label>' +
            '<input type="number" id="invEditRate" min="0" step="any" value="' + before.rate + '"></div>' +
          '<div><label for="invEditAmount">Amount (\u20B9)</label>' +
            '<input type="number" id="invEditAmount" min="0" step="any" value="' + before.amount + '"></div>' +
        '</div><div class="modal-hint">Amount follows qty \u00D7 rate: change either and the amount updates with it.</div></div>',
      confirmText: 'Save figures',
      confirmClass: 'btn-primary',
      onConfirm: function () { applyInvestmentEdit(id, before); }
    });

    var qtyEl = $('invEditQty'), rateEl = $('invEditRate'), amtEl = $('invEditAmount'), ok = $('modalOk');
    var hintEl = document.querySelector('#modalBackdrop .modal-hint');
    if (!qtyEl || !rateEl || !amtEl || !ok) return;

    /* Once the amount is typed by hand we stop recomputing it, so a deliberate
       figure is never silently thrown away by a later qty/rate tweak. The hint
       under the fields keeps the qty x rate relationship visible either way. */
    var amountTyped = false;

    function readNum(el) {
      var raw = String(el.value).trim();
      if (raw === '') return NaN;
      var n = Number(raw);
      return isFinite(n) ? n : NaN;
    }
    function money(n) { return inr(n, Number.isInteger(n) ? 0 : 2); }
    /* keep the confirm button off until all three fields hold a usable number,
       so a typo can never be written to the files */
    function refresh() {
      var q = readNum(qtyEl), r = readNum(rateEl), a = readNum(amtEl);
      ok.disabled = !(isFinite(q) && isFinite(r) && isFinite(a)) || q < 0 || r < 0 || a < 0;
      if (!hintEl) return;
      var expected = (isFinite(q) && isFinite(r)) ? +(q * r).toFixed(2) : null;
      hintEl.innerHTML = (expected !== null && isFinite(a) && a !== expected)
        ? 'Amount differs from qty \u00D7 rate (' + esc(money(expected)) + ') \u2014 it will be saved exactly as typed.'
        : 'Amount follows qty \u00D7 rate: change either and the amount updates with it.';
    }
    function recalc() {
      if (!amountTyped) {
        var q = readNum(qtyEl), r = readNum(rateEl);
        if (isFinite(q) && isFinite(r)) amtEl.value = String(+(q * r).toFixed(2));
      }
      refresh();
    }

    qtyEl.addEventListener('input', recalc);
    rateEl.addEventListener('input', recalc);
    amtEl.addEventListener('input', function () { amountTyped = true; refresh(); });
    [qtyEl, rateEl, amtEl].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!ok.disabled) ok.click();
      });
    });
    refresh();

    /* openModal focuses the confirm button 40ms after opening, so claim focus
       back afterwards rather than fighting it */
    setTimeout(function () { qtyEl.focus(); qtyEl.select(); }, 60);
  }

  /* -> both copies, then all 3 files, then a pop-up confirming the save */
  function applyInvestmentEdit(id, before) {
    if (!guardWrite()) return;
    var row = rawOrderRow('investments', id);
    if (!row) { toast('That investment is not in the loaded data any more.', 'err'); return; }

    var qtyEl = $('invEditQty'), rateEl = $('invEditRate'), amtEl = $('invEditAmount');
    if (!qtyEl || !rateEl || !amtEl) return;

    var qty = Number(String(qtyEl.value).trim());
    var rate = Number(String(rateEl.value).trim());
    var amount = Number(String(amtEl.value).trim());
    if (!isFinite(qty) || !isFinite(rate) || !isFinite(amount)) {
      toast('Qty, rate and amount must all be numbers.', 'err');
      return;
    }
    if (qty < 0 || rate < 0 || amount < 0) {
      toast('Qty, rate and amount cannot be negative.', 'err');
      return;
    }
    amount = +amount.toFixed(2);

    if (qty === before.qty && rate === before.rate && amount === before.amount) {
      toast('Nothing changed \u2014 nothing was written.', '');
      return;
    }

    /* state.base is what gets written to the files, state.data is what renders.
       Mutating only one of them either saves nothing or shows nothing. */
    var touched = 0;
    ['base', 'data'].forEach(function (which) {
      var list = (state[which] && state[which].investments) || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) !== String(id)) continue;
        if (which === 'base') touched++;
        var next = Object.assign({}, list[i]);   /* a fresh object per copy, never shared */
        next.qty = qty;
        next.rate = rate;
        next.amount = amount;
        list[i] = next;
      }
    });
    if (!touched) { toast('That investment is not in the loaded data any more.', 'err'); return; }

    writeAll('Investment figures saved to all 3 files.')
      .then(function (res) {
        if (res && res.ok) {
          renderAll();
          openModal({
            tone: 'ok',
            icon: '\u2705',
            title: 'Investment saved',
            message: 'Written to the <b>main local file</b>, the <b>2nd local copy</b> and the <b>repo copy</b>. ' +
              'Commit &amp; push the repo copy to publish it to the live site.',
            detail: esc(row.item || '') + ' \u00B7 ' + dNice(row.date) +
              '<br>Qty ' + nf(before.qty) + ' \u2192 <b>' + nf(qty) + '</b>' +
              '<br>Rate ' + inr(before.rate) + ' \u2192 <b>' + inr(rate) + '</b>' +
              '<br>Amount ' + inr(before.amount) + ' \u2192 <b>' + inr(amount) + '</b>',
            confirmText: 'Done',
            confirmClass: 'btn-confirm'
          });
        }
      });
  }

  function requestUndo() {
    var n = state.pending.length;
    if (!n) return;
    openModal({
      tone: '',
      icon: '\u21A9\uFE0F',
      title: 'Undo all deletes?',
      message: 'All <b>' + n + '</b> staged deletion' + (n === 1 ? '' : 's') +
        ' will be discarded and the data restored by reading the <b>main local file</b>.',
      confirmText: 'Yes, undo deletes',
      confirmClass: 'btn-primary',
      onConfirm: doUndo
    });
  }

  /* ------------------------------------------------------------ order lines */
  /* An order can hold several pizzas. `row.lines` is the source of truth when it
     is present; a row WITHOUT it is a single line built from the old flat fields,
     so every order recorded before this existed keeps reading exactly as before.
     ALWAYS take money from these helpers \u2014 never multiply row.qty by
     row.sellingPrice / row.rate again. On a multi-pizza order those two fields are
     only a summary, so their product is NOT the order's value. */
  function rowLines(row, kind) {
    var isSw = kind === 'swiggy';
    var src = (row && row.lines) || [];
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var l = src[i] || {};
      var item = String(l.item == null ? '' : l.item);
      var qty = parseInt(l.qty, 10);
      if (!(qty > 0)) qty = 1;
      var price = parseFloat(l.price);
      if (isNaN(price) || price < 0) price = 0;
      out.push({ item: item, qty: qty, price: price });
    }
    if (!out.length) {
      var q = parseInt(row && row.qty, 10);
      out.push({
        item: (row && row.item) || '',
        qty: q > 0 ? q : 1,
        price: isSw ? (+((row && row.sellingPrice) || 0)) : (+((row && row.rate) || 0))
      });
    }
    return out;
  }

  /* the price column can only show one number, so say so when they differ */
  function priceVaries(lines) {
    for (var i = 1; i < lines.length; i++) if (lines[i].price !== lines[0].price) return true;
    return false;
  }

  function linesLabel(lines) {
    if (!lines.length) return '\u2014';
    if (lines.length === 1) return lines[0].item || '\u2014';
    return (lines[0].item || '\u2014') + ' +' + (lines.length - 1) + ' more';
  }

  /* the Item cell lists every pizza on the order. A single-pizza order renders
     exactly as it always did, so no existing row changes appearance. */
  function itemsCell(lines) {
    if (!lines || lines.length <= 1) return esc(lines && lines[0] ? lines[0].item : '');
    return '<div class="line-list">' + lines.map(function (l) {
      return '<div class="line-list-row"><span>' + esc(l.item || '\u2014') + '</span>' +
        '<span class="sub">\u00D7' + nf(l.qty) + '</span></div>';
    }).join('') + '</div>';
  }

  /* there is only one price column, so be honest when the pizzas differ */
  function priceCell(row) {
    if (row.priceVaries) {
      return '<span class="sub" title="the pizzas on this order were priced differently \u2014 open the invoice for the breakdown">varies</span>';
    }
    return nf((row.lines && row.lines[0] ? row.lines[0].price : 0));
  }

  /* ------------------------------------------------------- the lines editor */
  /* ONE reusable repeater drives the two add panels AND the ✏️ Items editor.
     render / wire / read all take the same .lines-editor root, so the panel and
     the modal can never drift apart. */
  function itemSelectHtml(channel, selected) {
    var html = '<option value="">Choose an item\u2026</option>';
    /* an item that is no longer on the menu must stay selectable, otherwise just
       opening the editor would silently change what was sold */
    if (selected && !menuIndex(channel)[selected]) {
      html += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (off menu)</option>';
    }
    return html + itemOptions(channel, selected);
  }

  function lineRowHtml(channel, line) {
    line = line || {};
    var price = (line.price || line.price === 0) ? line.price : '';
    var qty = line.qty > 0 ? line.qty : 1;
    return '<div class="line-edit">' +
      '<select class="line-item" aria-label="Menu item">' + itemSelectHtml(channel, line.item || '') + '</select>' +
      '<input type="number" class="line-price" min="0" step="1" placeholder="0" aria-label="Price" value="' + esc(price) + '">' +
      '<input type="number" class="line-qty" min="1" step="1" aria-label="Quantity" value="' + esc(qty) + '">' +
      '<button type="button" class="btn btn-ghost btn-sm line-del" title="Remove this pizza">\u2715</button>' +
      '</div>';
  }

  function refreshLineDelButtons(root) {
    var rows = root.querySelectorAll('.line-edit');
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i].querySelector('.line-del');
      if (b) b.hidden = rows.length <= 1;   /* never let an order end up with no pizzas */
    }
  }

  function syncLinesTotals(root) {
    var box = root.querySelector('.lines-total');
    if (!box) return;
    var rows = root.querySelectorAll('.line-edit'), picked = 0, units = 0, value = 0;
    for (var i = 0; i < rows.length; i++) {
      var p = parseFloat(rows[i].querySelector('.line-price').value);
      var q = parseInt(rows[i].querySelector('.line-qty').value, 10);
      if (isNaN(p) || p < 0) p = 0;
      if (!(q > 0)) q = 0;
      if (rows[i].querySelector('.line-item').value) picked++;
      units += q; value += p * q;
    }
    box.innerHTML = picked + (picked === 1 ? ' pizza' : ' pizzas') + ' \u00B7 ' + nf(units) +
      (units === 1 ? ' unit' : ' units') + ' \u00B7 <b>' + inr(value) + '</b>';
  }

  function renderLinesEditor(root, channel, lines) {
    if (!root) return;
    root.dataset.channel = channel;
    var body = root.querySelector('.lines-body');
    if (!body) return;
    var list = (lines && lines.length) ? lines : [{ item: '', price: '', qty: 1 }];
    body.innerHTML = list.map(function (l) { return lineRowHtml(channel, l); }).join('');
    refreshLineDelButtons(root);
    syncLinesTotals(root);
  }

  function wireLinesEditor(root) {
    if (!root || root.dataset.wired) return;
    root.dataset.wired = '1';
    var body = root.querySelector('.lines-body');

    /* delegated, so rows added later are covered without re-wiring */
    body.addEventListener('input', function () { syncLinesTotals(root); });
    body.addEventListener('change', function (e) {
      var sel = e.target.closest ? e.target.closest('.line-item') : null;
      if (sel) {
        var m = menuIndex(root.dataset.channel)[sel.value];
        /* picking an item fills in the menu price \u2014 still editable, because the
           exact amount charged can differ */
        if (m) sel.closest('.line-edit').querySelector('.line-price').value = m.price;
      }
      syncLinesTotals(root);
    });
    body.addEventListener('click', function (e) {
      var del = e.target.closest ? e.target.closest('.line-del') : null;
      if (!del) return;
      if (body.querySelectorAll('.line-edit').length <= 1) return;
      del.closest('.line-edit').remove();
      refreshLineDelButtons(root);
      syncLinesTotals(root);
    });
    root.querySelector('.line-add').addEventListener('click', function () {
      var tmp = document.createElement('div');
      tmp.innerHTML = lineRowHtml(root.dataset.channel, { item: '', price: '', qty: 1 });
      body.appendChild(tmp.firstChild);
      refreshLineDelButtons(root);
      syncLinesTotals(root);
    });
  }

  /* read the repeater back out WITHOUT validating \u2014 used only to carry a
     half-typed order across a rebuild of the item dropdowns */
  function snapshotLines(root) {
    var rows = root.querySelectorAll('.line-edit');
    if (!rows.length) return null;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      out.push({
        item: rows[i].querySelector('.line-item').value,
        price: rows[i].querySelector('.line-price').value,
        qty: rows[i].querySelector('.line-qty').value
      });
    }
    return out;
  }

  /* read the repeater back out; the first bad row stops it and names itself */
  function readLinesEditor(root) {
    var rows = root.querySelectorAll('.line-edit'), out = [];
    for (var i = 0; i < rows.length; i++) {
      var item = rows[i].querySelector('.line-item').value;
      var price = parseFloat(rows[i].querySelector('.line-price').value);
      var qty = parseInt(rows[i].querySelector('.line-qty').value, 10);
      if (!item) return { ok: false, error: 'Pizza ' + (i + 1) + ': choose a menu item.' };
      if (isNaN(price) || price < 0) return { ok: false, error: 'Pizza ' + (i + 1) + ': enter a price of 0 or more.' };
      if (!(qty > 0)) return { ok: false, error: 'Pizza ' + (i + 1) + ': quantity must be at least 1.' };
      out.push({ item: item, qty: qty, price: price });
    }
    if (!out.length) return { ok: false, error: 'Add at least one pizza.' };
    /* the same pizza at the same price is one line, not two */
    var merged = [];
    out.forEach(function (l) {
      for (var k = 0; k < merged.length; k++) {
        if (merged[k].item === l.item && merged[k].price === l.price) { merged[k].qty += l.qty; return; }
      }
      merged.push({ item: l.item, qty: l.qty, price: l.price });
    });
    return { ok: true, lines: merged };
  }

  /* the flat fields stay as a summary of the lines, so search, the item filter
     and anything else that reads row.item still behave sensibly */
  function linesSummary(lines, channel) {
    return {
      item: lines[0].item,
      sourceItem: lines[0].item,
      category: resolveCategory(channel, lines[0].item, 'veg'),
      qty: sum(lines, function (l) { return l.qty; })
    };
  }

  /* ------------------------------------------------------------ computed rows */
  function offlineRows() {
    var cpp = +settings().costPerPizza || 0;
    return state.data.offlineOrders.map(function (o) {
      var offer = +o.offerAmount || 0;
      /* each line is classified on its own, so a mixed order still colours every
         badge and every slice of the category doughnut correctly */
      var lines = rowLines(o, 'offline').map(function (l) {
        return Object.assign({}, l, {
          amount: l.qty * l.price,
          category: resolveCategory('offline', l.item, o.category)
        });
      });
      var qty = sum(lines, function (l) { return l.qty; });
      var amount = sum(lines, function (l) { return l.amount; });
      var final = amount - offer, cost = cpp * qty;
      return Object.assign({}, o, {
        lines: lines,
        lineItems: lines.map(function (l) { return l.item; }),
        lineCats: lines.map(function (l) { return l.category; }),
        itemLabel: linesLabel(lines),
        priceVaries: priceVaries(lines),
        /* the menu is the source of truth for the category, so moving an item
           between groups re-colours its table badges and the category charts.
           A deleted item falls back to the category stored on the order. */
        category: resolveCategory('offline', o.item, o.category),
        rate: lines[0].price, qty: qty, offer: offer,
        amount: amount, final: final, cost: cost, profit: final - cost
      });
    });
  }

  function swiggyRows() {
    /* weeks come from weekPeriods() \u2014 recorded payout ranges first, then the
       7-day grid \u2014 never from a hardcoded calendar */
    var periods = weekPeriods();
    return state.data.swiggyOrders.map(function (s) {
      var lines = rowLines(s, 'swiggy').map(function (l) {
        return Object.assign({}, l, {
          amount: l.qty * l.price,
          category: resolveCategory('swiggy', l.item, s.category)
        });
      });
      var qty = sum(lines, function (l) { return l.qty; });
      var gross = sum(lines, function (l) { return l.amount; });
      var w = null;
      if (s.date) {
        for (var i = 0; i < periods.length; i++) {
          if (s.date >= periods[i].start && s.date <= periods[i].end) { w = periods[i]; break; }
        }
      }
      return Object.assign({}, s, {
        lines: lines,
        lineItems: lines.map(function (l) { return l.item; }),
        lineCats: lines.map(function (l) { return l.category; }),
        itemLabel: linesLabel(lines),
        priceVaries: priceVaries(lines),
        sellingPrice: lines[0].price, qty: qty, gross: gross,
        category: resolveCategory('swiggy', s.item, s.category),
        weekStart: w ? w.start : '', weekEnd: w ? w.end : '',
        week: w, weekSource: w ? w.source : ''
      });
    });
  }

  function swiggyCost() { return settings().applyCostToSwiggy ? (+settings().costPerPizza || 0) : 0; }

  function payoutRows() {
    var all = swiggyRows();
    return state.data.swiggyPayouts.map(function (p) {
      var r = payoutRange(p);
      /* gross sales are taken over the payout's OWN range, so a custom or
         merged week is measured exactly as the user defined it */
      var inWeek = all.filter(function (x) { return x.date && x.date >= r.start && x.date <= r.end; });
      var gross = sum(inWeek, function (x) { return x.gross; });
      var payout = +p.payout || 0;
      var deducted = gross - payout;
      return Object.assign({}, p, {
        range: r,
        label: rangeLabel(r.start, r.end),
        axisLabel: shortRangeLabel(r.start, r.end),
        window: fullRangeLabel(r.start, r.end),
        days: daysBetween(r.start, r.end),
        payout: payout, gross: gross, orders: inWeek.length,
        units: sum(inWeek, function (x) { return x.qty; }),
        deducted: deducted, dedPct: gross > 0 ? (deducted / gross) * 100 : 0
      });
    }).sort(function (a, b) { return a.weekStart < b.weekStart ? -1 : 1; });
  }

  /* ------------------------------------------------------------ filters */
  function pass(row, f) {
    if (f.from && (!row.date || row.date < f.from)) return false;
    if (f.to && (!row.date || row.date > f.to)) return false;
    /* an order matches a type/item filter when ANY of its pizzas does \u2014 a mixed
       order shows up under both Veg and Non-Veg, which is what you want when you
       are asking "which orders had a pepperoni?" */
    if (f.cat && (row.lineCats || [row.category]).indexOf(f.cat) < 0) return false;
    if (f.item && (row.lineItems || [row.item]).indexOf(f.item) < 0) return false;
    if (f.q) {
      var hay = ((row.customer || '') + ' ' + (row.lineItems || [row.item]).join(' ') +
        ' ' + (row.sourceItem || '') + ' ' + (row.orderNo ? '#' + row.orderNo : '') +
        ' ' + (row.note || '')).toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function filteredOffline() { return offlineRows().filter(function (r) { return pass(r, state.filters.offline); }); }
  function filteredSwiggy() { return swiggyRows().filter(function (r) { return pass(r, state.filters.swiggy); }); }

  /* ------------------------------------------------------------ charts */
  function chart(id, cfg) {
    var cv = $(id);
    if (!cv) return;
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    state.charts[id] = new Chart(cv.getContext('2d'), cfg);
  }

  function baseOpts(extra) {
    var o = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
        tooltip: {
          backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8, titleFont: { size: 12 },
          bodyFont: { size: 12 }, displayColors: true, boxPadding: 4
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink, maxRotation: 40, autoSkip: true } },
        y: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }
      }
    };
    return Object.assign(o, extra || {});
  }

  function moneyTicks() {
    return { ticks: { font: { size: 10.5 }, color: COL.ink, callback: function (v) { return '\u20B9' + nf(v); } } };
  }

  function emptyChart(id, msg) {
    chart(id, {
      type: 'bar',
      data: { labels: [], datasets: [] },
      options: Object.assign(baseOpts(), {
        plugins: { legend: { display: false }, title: { display: true, text: msg, color: COL.ink, font: { size: 12, weight: '600' } } }
      })
    });
  }

  /* ------------------------------------------------------------ header */
  function renderHeader() {
    var badge = $('modeBadge'), txt = $('modeText'), note = $('headerNote'), foot = $('footerNote');
    badge.className = 'mode-badge';

    if (state.mode === 'server') {
      badge.classList.add('local');
      txt.textContent = 'LOCAL \u00B7 WRITING FILES';
      note.innerHTML = 'Adds and edits write to all 3 files. Deletes stage in the 2nd local copy.';
      foot.innerHTML = '';
    } else if (state.mode === 'draft') {
      badge.classList.add('draft');
      txt.textContent = 'LOCAL \u00B7 DRAFT ONLY';
      note.innerHTML = 'No file writer detected \u2014 edits stay in this browser.';
      foot.innerHTML = 'You are viewing the site locally but the local writer is not running, so the 3 data files cannot be updated. ' +
        'Run <code>start-local.bat</code> (or <code>node server.js</code>) and open <code>http://localhost:' + API_PORT +
        '</code> to write to the main local file, the 2nd local copy and the repo copy.';
    } else {
      badge.classList.add('live');
      txt.textContent = 'LIVE \u00B7 READ ONLY';
      note.innerHTML = 'Hosted copy \u2014 read only, read from the repo file.';
      foot.innerHTML = 'This is the published (read-only) copy. Everything here is read from the repo copy ' +
        '<code>data/babyz-data.js</code>.<br>' +
        'To add or delete rows, open the site locally, then commit &amp; push the updated repo copy.';
    }
  }

  function renderBanner() {
    var host = $('modeBanner');
    if (state.mode === 'server') {
      host.innerHTML = '';
    } else if (state.mode === 'draft') {
      host.innerHTML = '<div class="banner warn"><span class="bico">\u26A0\uFE0F</span><div><b>Draft mode.</b> ' +
        'The local file writer is not reachable, so rows are saved in this browser only. ' +
        'Run <code>start-local.bat</code> in the project folder, then reopen <code>http://localhost:' + API_PORT + '</code> ' +
        'to have adds, edits and deletes written to the real data files.' +
        (state.draftAvailable ? ' A previously saved draft was loaded.' : '') + '</div></div>';
    } else {
      host.innerHTML = '<div class="banner lock"><span class="bico">\uD83D\uDD12</span><div><b>Read-only live copy.</b> ' +
        'Every figure on this page is read from the repo copy committed to the repository. ' +
        'Adding, editing and deleting rows is disabled here by design \u2014 do that from the local copy, then commit &amp; push.</div></div>';
    }
  }

  /* ------------------------------------------------------------ pending bar */
  function renderPendingBar() {
    var bar = $('pendingBar');
    var n = state.pending.length;
    if (!bar) return;
    if (!n) {
      bar.hidden = true;
      document.body.classList.remove('has-pending');
      return;
    }
    bar.hidden = false;
    document.body.classList.add('has-pending');
    $('pendingTitle').textContent = n + (n === 1 ? ' row staged for deletion' : ' rows staged for deletion');
    var names = state.pending.slice(0, 3).map(function (p) { return p.label; }).join('  \u00B7  ');
    $('pendingSub').textContent = 'Removed from the 2nd local copy only \u2014 the main local file and the repo copy are untouched until you confirm.  ' +
      names + (n > 3 ? '  \u2026 +' + (n - 3) + ' more' : '');
  }

  /* ------------------------------------------------------------ KPI cards */
  function kpi(list) {
    return list.map(function (k) {
      return '<div class="kpi ' + (k.tone || '') + '">' +
        '<div class="label">' + k.label + '</div>' +
        '<div class="value">' + k.value + '</div>' +
        (k.foot ? '<div class="foot">' + k.foot + '</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderKPIs() {
    var cpp = +settings().costPerPizza || 0;

    /* ---- swiggy ---- */
    var sw = filteredSwiggy(), allSw = swiggyRows();
    var pay = payoutRows();
    var swGross = sum(sw, function (r) { return r.gross; });
    var swUnits = sum(sw, function (r) { return r.qty; });
    var swCost = swiggyCost() * swUnits;
    var payoutTotal = sum(pay, function (p) { return p.payout; });
    var grossAll = sum(allSw, function (r) { return r.gross; });
    var deduction = grossAll - payoutTotal;
    var dedPct = grossAll > 0 ? (deduction / grossAll) * 100 : 0;

    $('kpiSwiggy').innerHTML = kpi([
      { label: 'Swiggy revenue (payouts)', value: inr(payoutTotal, 2), tone: 'red', foot: pay.length + ' weekly payout(s) recorded' },
      { label: 'Gross sales on Swiggy', value: inr(grossAll, 0), foot: 'what customers paid' },
      { label: 'Commission + discounts', value: inr(deduction, 2), tone: 'ink', foot: pct(dedPct) + ' of gross sales' },
      { label: 'Swiggy orders', value: nf(sw.length), foot: nf(swUnits) + ' pizzas \u00B7 avg ' + inr(sw.length ? swGross / sw.length : 0) },
      { label: 'Avg deduction / week', value: pct(pay.length ? sum(pay, function (p) { return p.dedPct; }) / pay.length : 0), tone: 'ink', foot: 'across recorded weeks' },
      { label: 'Net after food cost', value: inr(payoutTotal - swCost, 2), tone: swCost ? 'green' : '', foot: swCost ? 'incl. ' + inr(swCost) + ' est. food cost' : 'food cost not applied' }
    ]);

    /* ---- offline ---- */
    var of = filteredOffline(), allOf = offlineRows();
    var ofRev = sum(of, function (r) { return r.final; });
    var ofUnits = sum(of, function (r) { return r.qty; });
    var ofCost = sum(of, function (r) { return r.cost; });
    var ofOffer = sum(of, function (r) { return r.offer; });
    var ofProfit = ofRev - ofCost;

    $('kpiOffline').innerHTML = kpi([
      { label: 'Offline revenue', value: inr(ofRev, 0), tone: 'green', foot: nf(of.length) + ' orders \u00B7 ' + nf(ofUnits) + ' pizzas' },
      { label: 'Avg order value', value: inr(of.length ? ofRev / of.length : 0), foot: 'after offers' },
      { label: 'Offers given', value: inr(ofOffer, 0), tone: 'ink', foot: nf(of.filter(function (r) { return r.offer > 0; }).length) + ' discounted orders' },
      { label: 'Est. food cost', value: inr(ofCost, 0), tone: 'ink', foot: nf(ofUnits) + ' \u00D7 ' + inr(cpp) },
      { label: 'Est. profit', value: inr(ofProfit, 0), tone: ofProfit >= 0 ? 'green' : 'red', foot: ofRev ? pct(ofProfit / ofRev * 100) + ' margin' : '\u2014' },
      { label: 'Pizzas sold offline', value: nf(ofUnits), foot: 'across ' + nf(of.length) + ' orders' }
    ]);

    /* ---- money ---- */
    var ofRevAll = sum(allOf, function (r) { return r.final; });
    var ofCostAll = sum(allOf, function (r) { return r.cost; });
    var invTotal = sum(state.data.investments, function (i) { return +i.amount || 0; });
    var revenue = ofRevAll + payoutTotal;
    var foodCost = ofCostAll + (swiggyCost() ? swiggyCost() * sum(allSw, function (r) { return r.qty; }) : 0);
    var netPos = revenue - invTotal;
    var estProfit = revenue - foodCost;

    $('kpiMoney').innerHTML = kpi([
      { label: 'Total money earned', value: inr(revenue, 2), foot: 'offline + Swiggy payouts' },
      { label: 'Offline revenue', value: inr(ofRevAll, 0), tone: 'green', foot: nf(allOf.length) + ' orders' },
      { label: 'Swiggy payout received', value: inr(payoutTotal, 2), tone: 'red', foot: nf(pay.length) + ' weeks paid' },
      { label: 'Total invested', value: inr(invTotal, 0), tone: 'ink', foot: nf(state.data.investments.length) + ' line items' },
      { label: 'Net position', value: inr(netPos, 2), tone: netPos >= 0 ? 'green' : 'red', foot: netPos >= 0 ? 'investment recovered' : 'still to recover' },
      { label: 'Recovery', value: pct(invTotal ? (revenue / invTotal) * 100 : 0), tone: 'ink', foot: 'revenue \u00F7 invested' },
      { label: 'Est. food cost', value: inr(foodCost, 0), tone: 'ink', foot: 'approx. ' + inr(cpp) + ' per pizza' },
      { label: 'Est. profit before investment', value: inr(estProfit, 0), tone: estProfit >= 0 ? 'green' : 'red', foot: 'revenue \u2212 food cost' },
      { label: 'Swiggy gross (info)', value: inr(grossAll, 0), tone: 'ink', foot: inr(deduction, 2) + ' deducted by Swiggy' }
    ]);
  }

  /* ------------------------------------------------------------ tables */
  /* The per-row editing controls are pencils that live INSIDE the cell holding the
     value they change, so the Actions column keeps only the invoice and the delete
     and a row does not stretch across the screen. Each pencil carries
     .readonly-hide and its handler re-checks guardWrite(), because the CSS alone
     protects nothing. */
  function pencil(attrs, title) {
    return '<button type="button" class="pencil readonly-hide" ' + attrs +
      ' title="' + esc(title) + '" aria-label="' + esc(title) + '">\u270F\uFE0F</button>';
  }

  /* the value, then its pencil, in one flex row */
  function cellEdit(valueHtml, pencilHtml) {
    return '<div class="cell-edit">' + valueHtml + pencilHtml + '</div>';
  }

  function customerCell(collection, row) {
    return cellEdit(esc(row.customer || '\u2014'),
      pencil('data-edit-customer="' + esc(collection) + '" data-id="' + esc(row.id) + '"',
        'Edit the customer name and save it to all 3 files'));
  }

  /* the order number only exists on Swiggy orders, so only that channel gets one */
  function orderNoCell(id, orderNo) {
    return cellEdit('<span class="mono">' + (orderNo ? '#' + esc(orderNo) : '<span class="sub">\u2014</span>') + '</span>',
      pencil('data-edit-order-no="' + esc(id) + '"',
        'Add or change this order\'s Swiggy order number (#XXXX) and save it to all 3 files'));
  }

  /* the pizzas on an order \u2014 both channels have them, so both get the pencil */
  function itemCell(collection, row) {
    return cellEdit(itemsCell(row.lines),
      pencil('data-edit-lines="' + esc(collection) + '" data-id="' + esc(row.id) + '"',
        'Change the pizzas on this order: add more, change a quantity or price, or remove one'));
  }

  /* what is left of a row's controls once the pencils moved into the cells: the
     invoice is available everywhere (the hosted copy included \u2014 it only reads the
     row), the delete button only ever appears on a page allowed to write */
  function actionsCell(collection, id) {
    return '<div class="row-actions">' +
      '<button class="btn btn-ghost btn-sm" data-invoice="' + esc(collection) + '" data-id="' + esc(id) +
        '" title="Preview this order as an invoice and download it as PDF or PNG">\uD83E\uDDFE Invoice</button>' +
      '<button class="btn btn-danger readonly-hide" data-del="' + esc(collection) + '" data-id="' + esc(id) +
        '">Delete</button>' +
      '</div>';
  }

  function catBadge(cat) {
    var cls = cat === 'veg' ? 'veg' : cat === 'nonveg' ? 'nonveg' : cat === 'combo' ? 'combo' : 'muted';
    var dot = cat === 'veg' ? '<i class="vd g"></i>' : cat === 'nonveg' ? '<i class="vd r"></i>' : cat === 'combo' ? '<i class="vd c"></i>' : '';
    return '<span class="badge ' + cls + '">' + dot + esc(CAT_LABEL[cat] || cat || '\u2014') + '</span>';
  }

  function renderTables() {
    renderSwiggyTable();
    renderPayoutTable();
    renderOfflineTable();
    renderInvTable();
  }

  function renderSwiggyTable() {
    var rows = filteredSwiggy().slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    var body = $('swTableBody'), foot = $('swTableFoot');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="11"><div class="empty"><span class="big">\uD83D\uDEF5</span>No Swiggy orders match the current filters.</div></td></tr>';
      foot.innerHTML = '';
    } else {
      body.innerHTML = rows.map(function (r, i) {
        return '<tr>' +
          '<td class="num mono">' + (i + 1) + '</td>' +
          '<td class="mono">' + dNice(r.date) + '</td>' +
          '<td>' + orderNoCell(r.id, r.orderNo) + '</td>' +
          '<td>' + customerCell('swiggyOrders', r) + '</td>' +
          '<td>' + itemCell('swiggyOrders', r) + '</td>' +
          '<td>' + catBadge(r.category) + '</td>' +
          '<td class="num mono">' + priceCell(r) + '</td>' +
          '<td class="num mono">' + nf(r.qty) + '</td>' +
          '<td class="num mono"><b>' + inr(r.gross) + '</b></td>' +
          '<td>' + (r.week
            ? '<span class="badge ' + (r.weekSource === 'payout' ? 'warn' : 'muted') + '" title="' +
              (r.weekSource === 'payout' ? 'Recorded payout week' : 'From the 7-day grid \u2014 no payout recorded for this week yet') +
              '">' + esc(periodLabel(r.week)) + '</span>'
            : '<span class="badge muted" title="Before 1 Sep 2026 \u2014 payout weeks start here">\u2014</span>') + '</td>' +
          '<td class="actions">' + actionsCell('swiggyOrders', r.id) + '</td>' +
          '</tr>';
      }).join('');
      foot.innerHTML = '<tr><td colspan="6">Total \u00B7 ' + nf(rows.length) + ' orders</td>' +
        '<td class="num">\u2014</td><td class="num mono">' + nf(sum(rows, function (r) { return r.qty; })) + '</td>' +
        '<td class="num mono">' + inr(sum(rows, function (r) { return r.gross; })) + '</td>' +
        '<td colspan="2"></td></tr>';
    }
    $('swTableCount').textContent = nf(rows.length) + ' of ' + nf(state.data.swiggyOrders.length) + ' rows shown';
  }

  function renderPayoutTable() {
    var rows = payoutRows();
    var body = $('swPayoutBody'), foot = $('swPayoutFoot');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="10"><div class="empty"><span class="big">\uD83D\uDCB8</span>No weekly payouts recorded yet.</div></td></tr>';
      foot.innerHTML = '';
      return;
    }
    body.innerHTML = rows.map(function (p) {
      var merged = (+p.mergedFrom || 1) > 1;
      return '<tr>' +
        '<td><span class="badge warn">' + esc(p.label) + '</span>' +
        (merged ? ' <span class="badge combo">merged \u00D7' + p.mergedFrom + '</span>' : '') + '</td>' +
        '<td class="mono">' + esc(p.window) + ' <span class="sub">\u00B7 ' + p.days + 'd</span></td>' +
        '<td class="num mono">' + nf(p.orders) + '</td>' +
        '<td class="num mono">' + inr(p.gross) + '</td>' +
        '<td class="num mono"><b>' + inr(p.payout, 2) + '</b></td>' +
        '<td class="num mono neg">' + inr(p.deducted, 2) + '</td>' +
        '<td class="num mono"><span class="badge ' + (p.gross <= 0 ? 'muted' : p.dedPct > 35 ? 'nonveg' : 'muted') + '">' +
        (p.gross > 0 ? pct(p.dedPct) : '\u2014') + '</span></td>' +
        '<td class="mono">' + (p.receivedOn ? dNice(p.receivedOn) : '\u2014') + '</td>' +
        '<td>' + esc(p.note || '') + '</td>' +
        '<td class="actions readonly-hide"><button class="btn btn-danger" data-del="swiggyPayouts" data-id="' + esc(p.id) + '">Delete</button></td>' +
        '</tr>';
    }).join('');

    var g = sum(rows, function (p) { return p.gross; });
    var pay = sum(rows, function (p) { return p.payout; });
    var ded = g - pay;
    foot.innerHTML = '<tr><td colspan="3">Total \u00B7 ' + nf(rows.length) + ' weeks</td>' +
      '<td class="num mono">' + inr(g) + '</td>' +
      '<td class="num mono">' + inr(pay, 2) + '</td>' +
      '<td class="num mono">' + inr(ded, 2) + '</td>' +
      '<td class="num mono">' + pct(g > 0 ? ded / g * 100 : 0) + '</td>' +
      '<td colspan="3"></td></tr>';
  }

  function renderOfflineTable() {
    var rows = filteredOffline().slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    var body = $('ofTableBody'), foot = $('ofTableFoot');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="13"><div class="empty"><span class="big">\uD83C\uDFEA</span>No offline orders match the current filters.</div></td></tr>';
      foot.innerHTML = '';
    } else {
      body.innerHTML = rows.map(function (r, i) {
        return '<tr>' +
          '<td class="num mono">' + (i + 1) + '</td>' +
          '<td class="mono">' + dNice(r.date) + '</td>' +
          '<td>' + customerCell('offlineOrders', r) + '</td>' +
          '<td>' + itemCell('offlineOrders', r) + '</td>' +
          '<td>' + catBadge(r.category) + '</td>' +
          '<td class="num mono">' + priceCell(r) + '</td>' +
          '<td class="num mono">' + nf(r.qty) + '</td>' +
          '<td class="num mono">' + nf(r.amount) + '</td>' +
          '<td class="num mono">' + (r.offer ? '<span class="neg">\u2212' + nf(r.offer) + '</span>' : '\u2014') + '</td>' +
          '<td class="num mono"><b>' + inr(r.final) + '</b></td>' +
          '<td class="num mono">' + nf(r.cost) + '</td>' +
          '<td class="num mono ' + (r.profit >= 0 ? 'pos' : 'neg') + '">' + nf(r.profit) + '</td>' +
          '<td class="actions">' + actionsCell('offlineOrders', r.id) + '</td>' +
          '</tr>';
      }).join('');
      foot.innerHTML = '<tr><td colspan="6">Total \u00B7 ' + nf(rows.length) + ' orders</td>' +
        '<td class="num mono">' + nf(sum(rows, function (r) { return r.qty; })) + '</td>' +
        '<td class="num mono">' + nf(sum(rows, function (r) { return r.amount; })) + '</td>' +
        '<td class="num mono">' + nf(sum(rows, function (r) { return r.offer; })) + '</td>' +
        '<td class="num mono">' + inr(sum(rows, function (r) { return r.final; })) + '</td>' +
        '<td class="num mono">' + nf(sum(rows, function (r) { return r.cost; })) + '</td>' +
        '<td class="num mono">' + nf(sum(rows, function (r) { return r.profit; })) + '</td>' +
        '<td></td></tr>';
    }
    $('ofTableCount').textContent = nf(rows.length) + ' of ' + nf(state.data.offlineOrders.length) + ' rows shown';
  }

  function renderInvTable() {
    var rows = state.data.investments.slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; });
    var body = $('invTableBody'), foot = $('invTableFoot');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty"><span class="big">\uD83E\uDDFE</span>No investments recorded yet.</div></td></tr>';
      foot.innerHTML = '';
      return;
    }
    body.innerHTML = rows.map(function (r, i) {
      return '<tr>' +
        '<td class="num mono">' + (i + 1) + '</td>' +
        '<td class="mono">' + (r.date ? dNice(r.date) : esc(r.dateLabel || '\u2014')) + '</td>' +
        '<td>' + esc(r.item) + '</td>' +
        '<td><span class="badge muted">' + esc(r.category || 'purchase') + '</span></td>' +
        '<td class="num mono">' + nf(r.qty) + '</td>' +
        '<td class="num mono">' + nf(r.rate) + '</td>' +
        '<td class="num mono"><b>' + inr(r.amount) + '</b></td>' +
        '<td class="actions readonly-hide"><div class="row-actions">' +
          /* the investment editor changes three adjacent columns at once, so there
             is no single cell to sit beside \u2014 the pencil stays in Actions */
          pencil('data-edit-investment="' + esc(r.id) + '"',
            'Edit this investment\'s quantity, rate and amount and save them to all 3 files') +
          '<button class="btn btn-danger" data-del="investments" data-id="' + esc(r.id) + '">Delete</button>' +
        '</div></td>' +
        '</tr>';
    }).join('');
    foot.innerHTML = '<tr><td colspan="6">Total invested</td>' +
      '<td class="num mono">' + inr(sum(rows, function (r) { return +r.amount || 0; })) + '</td><td></td></tr>';
    $('invTableCount').textContent = nf(rows.length) + ' line items';
  }

  /* ------------------------------------------------------------ menus */
  function menuHtml(channel) {
    var m = state.data.menus[channel];
    var out = '';
    MENU_GROUPS.forEach(function (group) {
      var items = m[group] || [];
      var head = group === 'legacy'
        ? '<span class="badge muted">Legacy</span> no longer on the menu'
        : catBadge(group);
      out += '<div class="menu-group"><h4>' + head + ' (' + items.length + ')</h4>';

      if (!items.length) {
        out += '<div class="menu-empty">' + (group === 'legacy'
          ? 'Nothing parked here yet \u2014 use <b>Move</b> on an item to keep it selectable without listing it.'
          : 'No items in this group.') + '</div>';
      } else {
        out += items.map(function (it) {
          var sub = group === 'legacy'
            ? '<br><span class="sub">' + esc(CAT_LABEL[it.category] || '') + ' \u00B7 kept for old orders</span>'
            : '';
          var used = ordersUsing(channel, it.name);
          return '<div class="menu-item">' +
            '<span class="nm">' + esc(it.name) + sub + '</span>' +
            (used ? '<span class="badge muted" title="' + used + ' recorded order' + (used === 1 ? '' : 's') +
              ' use this item">' + used + '\u00D7</span>' : '') +
            '<span class="pr">' + inr(it.price) + '</span>' +
            '<span class="acts readonly-hide">' +
              '<button class="btn menu-btn" data-menu-move="' + esc(channel) + '" data-menu-name="' + esc(it.name) +
                '" title="Move this item to another group, including Legacy">Move</button>' +
              '<button class="btn btn-danger menu-btn" data-menu-del="' + esc(channel) + '" data-menu-name="' + esc(it.name) +
                '" title="Delete this item from the menu">\u2715</button>' +
            '</span>' +
            '</div>';
        }).join('');
      }
      out += '</div>';
    });
    return out;
  }

  function renderMenus() {
    $('menuOffline').innerHTML = menuHtml('offline');
    $('menuSwiggy').innerHTML = menuHtml('swiggy');
    syncMenuGroupForm('offline');
    syncMenuGroupForm('swiggy');
  }

  /* ------------------------------------------------------------ dropdowns */
  function itemOptions(channel, selected) {
    var m = state.data.menus[channel];
    var groups = [];
    CAT_ORDER.forEach(function (cat) {
      var items = (m[cat] || []).map(function (i) { return i.name; });
      if (items.length) groups.push({ label: CAT_LABEL[cat], items: items });
    });
    if ((m.legacy || []).length) groups.push({ label: 'Legacy / other', items: m.legacy.map(function (i) { return i.name; }) });
    var html = '';
    groups.forEach(function (g) {
      html += '<optgroup label="' + esc(g.label) + '">';
      html += g.items.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('');
      html += '</optgroup>';
    });
    return html;
  }

  function menuIndex(channel) {
    var m = state.data.menus[channel], idx = {};
    CAT_ORDER.forEach(function (cat) { (m[cat] || []).forEach(function (i) { idx[i.name] = { cat: cat, price: i.price }; }); });
    (m.legacy || []).forEach(function (i) { idx[i.name] = { cat: i.category || 'veg', price: i.price, legacy: true }; });
    return idx;
  }

  /* The menu decides an item's category. Only if the item is not in the menu at
     all (it was deleted) do we fall back to whatever the order itself recorded. */
  function resolveCategory(channel, item, stored) {
    var hit = menuIndex(channel)[item];
    return (hit && hit.cat) ? hit.cat : (stored || 'veg');
  }

  /* ------------------------------------------------------------ menu editing */
  /* Menus live in TWO objects: state.base (what gets written to the files) and
     state.data (what the page renders). Row adds write both, so menu edits must
     too \u2014 mutating only state.data updates the screen but saves nothing. */
  function menuApply(mutate) {
    mutate(state.base.menus);
    mutate(state.data.menus);
  }

  function menuList(channel, group) {
    var m = state.data.menus[channel] || {};
    return m[group] || [];
  }

  function findMenuGroup(channel, name) {
    var m = state.data.menus[channel];
    for (var i = 0; i < MENU_GROUPS.length; i++) {
      var list = m[MENU_GROUPS[i]] || [];
      for (var j = 0; j < list.length; j++) if (list[j].name === name) return MENU_GROUPS[i];
    }
    return null;
  }

  function menuItem(channel, name) {
    var g = findMenuGroup(channel, name);
    if (!g) return null;
    var list = menuList(channel, g);
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
    return null;
  }

  /* how many recorded orders reference this item on this channel */
  function ordersUsing(channel, name) {
    var coll = channel === 'offline' ? state.data.offlineOrders : state.data.swiggyOrders;
    return coll.filter(function (o) { return o.item === name; }).length;
  }

  function clearMenuForm(channel) {
    var n = $('menuName-' + channel), p = $('menuPrice-' + channel);
    if (n) n.value = '';
    if (p) p.value = '';
  }

  /* add -> confirm popup -> MAIN + STAGE + REPO, then everything re-renders */
  function requestMenuAdd(channel) {
    if (!guardWrite()) return;
    var nameEl = $('menuName-' + channel), priceEl = $('menuPrice-' + channel), groupEl = $('menuGroup-' + channel);
    var name = (nameEl.value || '').trim().replace(/\s+/g, ' ');
    var price = parseFloat(priceEl.value);
    var group = groupEl.value;

    if (!name) { toast('Type the item name first.', 'err'); nameEl.focus(); return; }
    if (isNaN(price) || price < 0) { toast('Enter a valid price for "' + name + '".', 'err'); priceEl.focus(); return; }

    var already = findMenuGroup(channel, name);
    if (already) {
      toast('"' + name + '" is already in the ' + MENU_GROUP_LABEL[already] + ' group.', 'err');
      return;
    }

    var item = { name: name, price: price };
    var detail = '<b>' + esc(name) + '</b> \u00B7 ' + inr(price) + '<br>' +
      esc(CHANNEL_LABEL[channel]) + ' menu \u2192 <b>' + esc(MENU_GROUP_LABEL[group]) + '</b>';
    if (group === 'legacy') {
      /* a legacy item still needs a category so old orders keep classifying */
      var keep = ($('menuLegacyCat-' + channel) || {}).value || 'veg';
      item.category = keep;
      detail += ' <span class="sub">(kept as ' + esc(MENU_GROUP_LABEL[keep]) + ')</span>';
    }

    openModal({
      tone: 'add',
      icon: '\u2795',
      title: 'Add this item to the menu?',
      message: 'It is saved to the <b>main local file</b>, the <b>2nd local copy</b> and the <b>repo copy</b> at once, ' +
        'and every menu dropdown, table badge and chart refreshes straight away.',
      detail: detail,
      confirmText: 'Yes, add item',
      confirmClass: 'btn-primary',
      onConfirm: function () {
        menuApply(function (menus) {
          var m = menus[channel];
          if (!m[group]) m[group] = [];
          /* a fresh object per copy \u2014 never share a reference between base and data */
          var copy = { name: item.name, price: item.price };
          if (item.category) copy.category = item.category;
          m[group].push(copy);
        });
        writeAll('Added "' + name + '" to the ' + CHANNEL_LABEL[channel] + ' \u00B7 ' + MENU_GROUP_LABEL[group] + ' list.')
          .then(function (res) {
            if (!res || !res.ok) return;
            clearMenuForm(channel);
            renderAll();
          });
      }
    });
  }

  /* move -> confirm popup with a target picker (legacy is just another target) */
  function requestMenuMove(channel, name) {
    if (!guardWrite()) return;
    var from = findMenuGroup(channel, name);
    var item = menuItem(channel, name);
    if (!from || !item) return;

    var targets = MENU_GROUPS.filter(function (g) { return g !== from; });
    var sel = '<div class="field" style="margin-top:10px"><label for="menuMoveTarget">Move to</label>' +
      '<select id="menuMoveTarget">' + targets.map(function (g) {
        return '<option value="' + g + '"' + (g === 'legacy' ? ' selected' : '') + '>' +
          MENU_GROUP_LABEL[g] + (g === 'legacy' ? ' (off the menu)' : '') + '</option>';
      }).join('') + '</select></div>';

    openModal({
      tone: 'warn',
      icon: '\u2194\uFE0F',
      title: 'Move this menu item?',
      message: 'Its category follows it, so the item badges, the category doughnuts and the item dropdowns all update.',
      detail: '<b>' + esc(name) + '</b> \u00B7 ' + inr(item.price) + '<br>currently in <b>' +
        esc(MENU_GROUP_LABEL[from]) + '</b>' + sel,
      confirmText: 'Yes, move item',
      confirmClass: 'btn-primary',
      onConfirm: function () {
        var el = $('menuMoveTarget');
        if (!el || !el.value) return;
        doMenuMove(channel, name, el.value);
      }
    });
  }

  function doMenuMove(channel, name, to) {
    var from = findMenuGroup(channel, name);
    if (!from || from === to) return;

    var found = false;
    menuApply(function (menus) {
      var m = menus[channel];
      var list = m[from] || [];
      var i = -1;
      for (var k = 0; k < list.length; k++) if (list[k].name === name) { i = k; break; }
      if (i < 0) return;
      var item = list.splice(i, 1)[0];
      found = true;
      var next = { name: item.name, price: item.price };
      /* legacy items keep the category they came from, so old orders still classify */
      if (to === 'legacy') next.category = item.category || from;
      if (!m[to]) m[to] = [];
      m[to].push(next);
    });
    if (!found) return;

    writeAll('Moved "' + name + '" to ' + CHANNEL_LABEL[channel] + ' \u00B7 ' + MENU_GROUP_LABEL[to] + '.')
      .then(function (res) { if (res && res.ok) renderAll(); });
  }

  /* delete -> confirm popup, warning when historical orders still use the item */
  function requestMenuDelete(channel, name) {
    if (!guardWrite()) return;
    var group = findMenuGroup(channel, name);
    var item = menuItem(channel, name);
    if (!group || !item) return;

    var used = ordersUsing(channel, name);
    var warn = used
      ? '<div class="menu-warn"><b>' + used + '</b> recorded ' + CHANNEL_LABEL[channel].toLowerCase() +
        ' order' + (used === 1 ? '' : 's') + ' use this item. They keep their name and category, so no history is lost \u2014 ' +
        'but the item drops out of the item dropdown. <b>Move to Legacy</b> keeps it selectable instead.</div>'
      : '';

    openModal({
      tone: 'danger',
      icon: '\uD83D\uDDD1\uFE0F',
      title: 'Are you sure you want to delete this menu item?',
      message: 'It is removed from the menu and written to the <b>main local file</b>, the <b>2nd local copy</b> and the ' +
        '<b>repo copy</b> right away, and every dropdown, badge and chart refreshes straight away.',
      detail: '<b>' + esc(name) + '</b> \u00B7 ' + inr(item.price) + '<br>' + esc(CHANNEL_LABEL[channel]) +
        ' \u2192 <b>' + esc(MENU_GROUP_LABEL[group]) + '</b>' + warn,
      confirmText: 'Yes, delete item',
      confirmClass: 'btn-solid-danger',
      onConfirm: function () {
        menuApply(function (menus) {
          var list = (menus[channel] || {})[group] || [];
          for (var k = 0; k < list.length; k++) {
            if (list[k].name === name) { list.splice(k, 1); break; }
          }
        });
        writeAll('Deleted "' + name + '" from the ' + CHANNEL_LABEL[channel] + ' menu.')
          .then(function (res) { if (res && res.ok) renderAll(); });
      }
    });
  }

  /* legacy items reveal a "kept as" picker in the add form */
  function syncMenuGroupForm(channel) {
    var g = ($('menuGroup-' + channel) || {}).value;
    var box = $('menuLegacyCatField-' + channel);
    if (box) box.hidden = (g !== 'legacy');
  }

  function renderFilters() {
    var f = state.filters;
    $('swFrom').value = f.swiggy.from; $('swTo').value = f.swiggy.to; $('swQ').value = f.swiggy.q; $('swCat').value = f.swiggy.cat;
    $('ofFrom').value = f.offline.from; $('ofTo').value = f.offline.to; $('ofQ').value = f.offline.q; $('ofCat').value = f.offline.cat;

    var swSel = $('swItem'), ofSel = $('ofItem');
    swSel.innerHTML = '<option value="">All items</option>' + itemOptions('swiggy', f.swiggy.item);
    ofSel.innerHTML = '<option value="">All items</option>' + itemOptions('offline', f.offline.item);
    swSel.value = f.swiggy.item; ofSel.value = f.offline.item;

    /* The lines editor is built once and then left alone \u2014 rebuilding it on every
       renderAll() would wipe a half-typed order. It IS rebuilt when the MENU
       changes, so an item you just added or moved shows up in the dropdowns
       without a page reload; whatever is already typed is carried across. */
    var menuSig = JSON.stringify(state.data.menus);
    [['swLines', 'swiggy'], ['ofLines', 'offline']].forEach(function (pair) {
      var root = $(pair[0]);
      if (!root) return;
      if (root.dataset.ready && root.dataset.menuSig === menuSig) return;
      var keep = root.dataset.ready ? snapshotLines(root) : null;
      renderLinesEditor(root, pair[1], keep);
      wireLinesEditor(root);
      root.dataset.ready = '1';
      root.dataset.menuSig = menuSig;
    });
  }

  /* ------------------------------------------------------------ payout week picker */
  function updatePayoutEndPreview() {
    var start = $('swpStart').value;
    var box = $('swpEnd');
    if (!start) {
      box.textContent = 'Pick a start day';
      box.className = 'computed muted';
      return;
    }
    if (start < WEEK_MIN_START) {
      box.textContent = 'Before 1 Sep 2026 \u2014 not allowed';
      box.className = 'computed bad';
      return;
    }
    var end = payoutWeekEnd(start);
    var days = payoutWeekDays(start);
    box.textContent = dNice(end) + '  (' + days + ' day' + (days === 1 ? '' : 's') + ')';
    box.className = 'computed' + (days === 7 ? '' : ' short');
  }

  function renderPayoutWeekPicker() {
    var inp = $('swpStart');
    inp.min = WEEK_MIN_START;
    updatePayoutEndPreview();
  }

  function renderSettings() {
    $('costPerPizza').value = +settings().costPerPizza || 0;
    $('applyCostSwiggy').value = settings().applyCostToSwiggy ? 'yes' : 'no';
  }

  /* ------------------------------------------------------------ charts: swiggy */
  function renderSwiggyCharts() {
    var rows = filteredSwiggy();
    if (!rows.length) {
      ['swWeekChart', 'swDeductChart', 'swDailyChart', 'swItemsChart', 'swCatChart'].forEach(function (id) {
        emptyChart(id, 'No Swiggy orders match the current filters');
      });
      return;
    }

    var pay = payoutRows();
    var wkLabels = pay.map(function (p) { return p.axisLabel; });
    var wkFull = pay.map(function (p) { return p.window; });
    /* a deduction % needs gross sales to mean anything \u2014 a week with a payout
       but no recorded orders is left out rather than plotted as 0% */
    var dedPay = pay.filter(function (p) { return p.gross > 0; });
    if (!wkLabels.length) {
      emptyChart('swWeekChart', 'Add a weekly payout to compare against gross sales');
      emptyChart('swDeductChart', 'No weekly payouts recorded');
    } else {
      chart('swWeekChart', {
        type: 'bar',
        data: {
          labels: wkLabels,
          datasets: [
            { label: 'Gross sales', data: pay.map(function (p) { return p.gross; }), backgroundColor: COL.amberSoft, borderColor: COL.amber, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 46 },
            { label: 'Payout received', data: pay.map(function (p) { return p.payout; }), backgroundColor: COL.redSoft, borderColor: COL.red, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 46 }
          ]
        },
        options: baseOpts({
          plugins: {
            legend: { display: true, labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
            tooltip: {
              backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8,
              titleFont: { size: 12 }, bodyFont: { size: 12 }, displayColors: true, boxPadding: 4,
              callbacks: { title: function (items) { return wkFull[items[0].dataIndex] || ''; } }
            }
          },
          scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) }
        })
      });
      chart('swDeductChart', {
        type: 'line',
        data: {
          labels: dedPay.map(function (p) { return p.axisLabel; }),
          datasets: [{
            label: 'Deducted %', data: dedPay.map(function (p) { return +p.dedPct.toFixed(2); }),
            borderColor: COL.red, backgroundColor: COL.redSoft, fill: true, tension: .32,
            pointBackgroundColor: '#fff', pointBorderColor: COL.red, pointBorderWidth: 2, pointRadius: 5
          }]
        },
        options: baseOpts({
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8,
              titleFont: { size: 12 }, bodyFont: { size: 12 }, displayColors: true, boxPadding: 4,
              callbacks: {
                title: function (items) { return dedPay[items[0].dataIndex] ? dedPay[items[0].dataIndex].window : ''; },
                label: function (c) { return 'Deducted ' + c.parsed.y.toFixed(1) + '%'; }
              }
            }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } },
            y: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink, callback: function (v) { return v + '%'; } } }
          }
        })
      });
      if (!dedPay.length) emptyChart('swDeductChart', 'No week with recorded sales yet \u2014 deduction % needs gross sales');
    }

    var byDay = {};
    rows.forEach(function (r) { if (r.date) byDay[r.date] = (byDay[r.date] || 0) + r.gross; });
    var days = Object.keys(byDay).sort();
    chart('swDailyChart', {
      type: 'line',
      data: {
        labels: days.map(dShort),
        datasets: [{
          label: 'Gross sales', data: days.map(function (d) { return byDay[d]; }),
          borderColor: COL.orange, backgroundColor: 'rgba(255,122,24,.14)', fill: true, tension: .3,
          pointBackgroundColor: '#fff', pointBorderColor: COL.orange, pointBorderWidth: 2, pointRadius: 4
        }]
      },
      options: baseOpts({ plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8 } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
    });

    var byItem = {};
    /* every pizza on a multi-pizza order counts towards its own item's bar */
    rows.forEach(function (r) {
      (r.lines || []).forEach(function (l) {
        if (!l.item) return;
        byItem[l.item] = (byItem[l.item] || 0) + l.qty;
      });
    });
    var itemKeys = Object.keys(byItem).sort(function (a, b) { return byItem[b] - byItem[a]; }).slice(0, 10);
    var itemColors = itemKeys.map(function (k) {
      var cat = (menuIndex('swiggy')[k] || {}).cat;
      return cat === 'veg' ? COL.green : cat === 'nonveg' ? COL.red : COL.purple;
    });
    chart('swItemsChart', {
      type: 'bar',
      data: {
        labels: itemKeys.map(function (k) { return k.length > 26 ? k.slice(0, 25) + '\u2026' : k; }),
        datasets: [{ label: 'Units sold', data: itemKeys.map(function (k) { return byItem[k]; }), backgroundColor: itemColors, borderRadius: 6, maxBarThickness: 34 }]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8 } },
        scales: { x: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink, precision: 0 } }, y: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } } }
      })
    });

    var byCat = { veg: 0, nonveg: 0, combo: 0 };
    /* a mixed order is split by pizza, not lumped under one type */
    rows.forEach(function (r) {
      (r.lines || []).forEach(function (l) { byCat[l.category] = (byCat[l.category] || 0) + l.amount; });
    });
    var tot = sum(CAT_ORDER.map(function (c) { return byCat[c]; }));
    chart('swCatChart', {
      type: 'doughnut',
      data: {
        labels: CAT_ORDER.map(function (c) { return CAT_LABEL[c]; }),
        datasets: [{ data: CAT_ORDER.map(function (c) { return byCat[c]; }), backgroundColor: [COL.green, COL.red, COL.purple], borderColor: '#fff', borderWidth: 3, hoverOffset: 8 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
          tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8, callbacks: { label: function (c) { return c.label + ': ' + inr(c.parsed) + ' (' + pct(tot ? c.parsed / tot * 100 : 0) + ')'; } } }
        }
      }
    });
  }

  /* ------------------------------------------------------------ charts: offline */
  function renderOfflineCharts() {
    var rows = filteredOffline();
    if (!rows.length) {
      ['ofDayChart', 'ofWeekChart', 'ofItemsChart', 'ofCatChart', 'ofCumChart'].forEach(function (id) {
        emptyChart(id, 'No offline orders match the current filters');
      });
      return;
    }

    var byDay = {};
    rows.forEach(function (r) {
      if (!r.date) return;
      if (!byDay[r.date]) byDay[r.date] = { rev: 0, cost: 0 };
      byDay[r.date].rev += r.final; byDay[r.date].cost += r.cost;
    });
    var days = Object.keys(byDay).sort();
    chart('ofDayChart', {
      type: 'bar',
      data: {
        labels: days.map(dShort),
        datasets: [
          { label: 'Revenue', data: days.map(function (d) { return byDay[d].rev; }), backgroundColor: 'rgba(22,163,74,.75)', borderColor: COL.green, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 42 },
          { label: 'Est. food cost', data: days.map(function (d) { return byDay[d].cost; }), backgroundColor: 'rgba(255,122,24,.45)', borderColor: COL.orange, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 42 }
        ]
      },
      options: baseOpts({ scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
    });

    var wkMap = {};
    rows.forEach(function (r) {
      var w = weekOf(r.date);
      if (!w) return;
      if (!wkMap[w.start]) wkMap[w.start] = { w: w, rev: 0, profit: 0, units: 0 };
      wkMap[w.start].rev += r.final; wkMap[w.start].profit += r.profit; wkMap[w.start].units += r.qty;
    });
    var wks = Object.keys(wkMap).sort().map(function (k) { return wkMap[k]; });
    chart('ofWeekChart', {
      type: 'bar',
      data: {
        labels: wks.map(function (x) { return weekLabel(x.w); }),
        datasets: [
          { label: 'Revenue', data: wks.map(function (x) { return x.rev; }), backgroundColor: 'rgba(15,81,50,.78)', borderColor: COL.greenDeep, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 42 },
          { label: 'Est. profit', data: wks.map(function (x) { return x.profit; }), backgroundColor: 'rgba(255,179,71,.75)', borderColor: COL.amber, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 42 }
        ]
      },
      options: baseOpts({ scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
    });

    var byItem = {};
    /* every pizza on a multi-pizza order counts towards its own item's bar */
    rows.forEach(function (r) {
      (r.lines || []).forEach(function (l) {
        if (!l.item) return;
        byItem[l.item] = (byItem[l.item] || 0) + l.qty;
      });
    });
    var itemKeys = Object.keys(byItem).sort(function (a, b) { return byItem[b] - byItem[a]; }).slice(0, 10);
    var idx = menuIndex('offline');
    var itemColors = itemKeys.map(function (k) {
      var cat = (idx[k] || {}).cat;
      return cat === 'veg' ? COL.green : cat === 'nonveg' ? COL.red : COL.purple;
    });
    chart('ofItemsChart', {
      type: 'bar',
      data: {
        labels: itemKeys.map(function (k) { return k.length > 26 ? k.slice(0, 25) + '\u2026' : k; }),
        datasets: [{ label: 'Units sold', data: itemKeys.map(function (k) { return byItem[k]; }), backgroundColor: itemColors, borderRadius: 6, maxBarThickness: 34 }]
      },
      options: baseOpts({
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8 } },
        scales: { x: { beginAtZero: true, grid: { color: COL.grid }, border: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink, precision: 0 } }, y: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } } }
      })
    });

    var byCat = { veg: 0, nonveg: 0, combo: 0 };
    /* the offer belongs to the ORDER, not to one pizza, so spread it across the
       lines in proportion to their value \u2014 the doughnut total still equals the
       sum of the orders' final amounts, exactly as before */
    rows.forEach(function (r) {
      (r.lines || []).forEach(function (l) {
        var share = r.amount > 0 ? l.amount / r.amount : 0;
        byCat[l.category] = (byCat[l.category] || 0) + (l.amount - r.offer * share);
      });
    });
    var totalCat = sum(CAT_ORDER.map(function (c) { return byCat[c]; }));
    chart('ofCatChart', {
      type: 'doughnut',
      data: {
        labels: CAT_ORDER.map(function (c) { return CAT_LABEL[c]; }),
        datasets: [{ data: CAT_ORDER.map(function (c) { return byCat[c]; }), backgroundColor: [COL.green, COL.red, COL.purple], borderColor: '#fff', borderWidth: 3, hoverOffset: 8 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
          tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8, callbacks: { label: function (c) { return c.label + ': ' + inr(c.parsed) + ' (' + pct(totalCat ? c.parsed / totalCat * 100 : 0) + ')'; } } }
        }
      }
    });

    var cum = 0;
    var cumData = days.map(function (d) { cum += byDay[d].rev; return +cum.toFixed(2); });
    chart('ofCumChart', {
      type: 'line',
      data: {
        labels: days.map(dShort),
        datasets: [{ label: 'Cumulative revenue', data: cumData, borderColor: COL.greenDeep, backgroundColor: 'rgba(15,81,50,.12)', fill: true, tension: .28, pointRadius: 0, borderWidth: 2.5 }]
      },
      options: baseOpts({ plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8 } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
    });
  }

  /* ------------------------------------------------------------ charts: money */
  function renderMoneyCharts() {
    /* the axis follows the recorded payout weeks (new logic), not a hardcoded
       calendar \u2014 add N payout rows and N weeks appear here automatically */
    var periods = weekPeriods();
    var ofAll = offlineRows().filter(function (r) { return r.date; });
    var pay = state.data.swiggyPayouts;
    var inv = state.data.investments.filter(function (i) { return i.date; });

    var series = periods.map(function (w) {
      var o = ofAll.filter(function (r) { return r.date >= w.start && r.date <= w.end; });
      var v = inv.filter(function (x) { return x.date >= w.start && x.date <= w.end; });
      /* a payout belongs to the period holding its start day */
      var p = pay.filter(function (x) {
        var r = payoutRange(x);
        return !!r.start && r.start >= w.start && r.start <= w.end;
      });
      return {
        w: w,
        offline: sum(o, function (r) { return r.final; }),
        swiggy: sum(p, function (x) { return +x.payout || 0; }),
        spend: sum(v, function (x) { return +x.amount || 0; })
      };
    });

    var active = series.filter(function (s) { return s.offline || s.swiggy || s.spend; });
    if (!active.length) {
      ['mnChannelChart', 'mnShareChart', 'mnCumChart', 'mnProfitChart', 'mnInvChart'].forEach(function (id) {
        emptyChart(id, 'No data yet');
      });
      return;
    }
    var first = series.indexOf(active[0]), last = series.indexOf(active[active.length - 1]);
    series = series.slice(first, last + 1);
    var labels = series.map(function (s) { return shortRangeLabel(s.w.start, s.w.end); });
    var fullLabels = series.map(function (s) { return fullRangeLabel(s.w.start, s.w.end); });

    chart('mnChannelChart', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Offline revenue', data: series.map(function (s) { return s.offline; }), backgroundColor: 'rgba(22,163,74,.78)', borderColor: COL.green, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 34, stack: 'rev' },
          { label: 'Swiggy payout', data: series.map(function (s) { return s.swiggy; }), backgroundColor: 'rgba(225,29,72,.7)', borderColor: COL.red, borderWidth: 1.5, borderRadius: 6, maxBarThickness: 34, stack: 'rev' },
          { label: 'Invested that week', data: series.map(function (s) { return s.spend; }), type: 'line', borderColor: COL.orange, backgroundColor: 'rgba(255,122,24,.1)', borderWidth: 2.5, tension: .3, pointRadius: 3, pointBackgroundColor: '#fff', pointBorderColor: COL.orange, pointBorderWidth: 2, fill: false }
        ]
      },
      options: baseOpts({
        plugins: {
          legend: { labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
          tooltip: {
            backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8,
            titleFont: { size: 12 }, bodyFont: { size: 12 }, displayColors: true, boxPadding: 4,
            callbacks: { title: function (items) { return fullLabels[items[0].dataIndex] || ''; } }
          }
        },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink } }, y: Object.assign({ stacked: true, beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) }
      })
    });

    var ofRev = sum(ofAll, function (r) { return r.final; });
    var swRev = sum(pay, function (p) { return +p.payout || 0; });
    chart('mnShareChart', {
      type: 'doughnut',
      data: {
        labels: ['Offline revenue', 'Swiggy payouts'],
        datasets: [{ data: [ofRev, swRev], backgroundColor: [COL.green, COL.red], borderColor: '#fff', borderWidth: 3, hoverOffset: 8 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '60%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 11, weight: '600' } } },
          tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8, callbacks: { label: function (c) { var t = ofRev + swRev; return c.label + ': ' + inr(c.parsed, 2) + ' (' + pct(t ? c.parsed / t * 100 : 0) + ')'; } } }
        }
      }
    });

    var dates = {};
    ofAll.forEach(function (r) { dates[r.date] = 1; });
    inv.forEach(function (i) { dates[i.date] = 1; });
    pay.forEach(function (p) { if (p.receivedOn) dates[p.receivedOn] = 1; });
    var dayKeys = Object.keys(dates).sort();
    if (!dayKeys.length) { emptyChart('mnCumChart', 'No dated records yet'); }
    else {
      var cRev = 0, cInv = 0, revLine = [], invLine = [];
      dayKeys.forEach(function (d) {
        cRev += sum(ofAll.filter(function (r) { return r.date === d; }), function (r) { return r.final; });
        cRev += sum(pay.filter(function (p) { return p.receivedOn === d; }), function (p) { return +p.payout || 0; });
        cInv += sum(inv.filter(function (i) { return i.date === d; }), function (i) { return +i.amount || 0; });
        revLine.push(+cRev.toFixed(2)); invLine.push(+cInv.toFixed(2));
      });
      chart('mnCumChart', {
        type: 'line',
        data: {
          labels: dayKeys.map(dShort),
          datasets: [
            { label: 'Cumulative investment', data: invLine, borderColor: COL.orange, backgroundColor: 'rgba(255,122,24,.12)', fill: true, tension: .25, borderWidth: 2.5, pointRadius: 0 },
            { label: 'Cumulative revenue', data: revLine, borderColor: COL.greenDeep, backgroundColor: 'rgba(15,81,50,.14)', fill: true, tension: .25, borderWidth: 2.5, pointRadius: 0 }
          ]
        },
        options: baseOpts({ scales: { x: { grid: { display: false }, ticks: { font: { size: 10.5 }, color: COL.ink, autoSkip: true, maxTicksLimit: 14 } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
      });
    }

    var ofCostAll = sum(offlineRows(), function (r) { return r.cost; });
    var swCostAll = swiggyCost() ? swiggyCost() * sum(swiggyRows(), function (r) { return r.qty; }) : 0;
    chart('mnProfitChart', {
      type: 'bar',
      data: {
        labels: ['Offline', 'Swiggy'],
        datasets: [
          { label: 'Revenue', data: [ofRev, swRev], backgroundColor: ['rgba(22,163,74,.8)', 'rgba(225,29,72,.75)'], borderRadius: 6, maxBarThickness: 60 },
          { label: 'Est. food cost', data: [ofCostAll, swCostAll], backgroundColor: ['rgba(255,179,71,.7)', 'rgba(255,122,24,.6)'], borderRadius: 6, maxBarThickness: 60 }
        ]
      },
      options: baseOpts({ scales: { x: { grid: { display: false }, ticks: { font: { size: 11.5 }, color: COL.ink } }, y: Object.assign({ beginAtZero: true, grid: { color: COL.grid }, border: { display: false } }, moneyTicks()) } })
    });

    var byCat = {};
    state.data.investments.forEach(function (i) { var c = i.category || 'purchase'; byCat[c] = (byCat[c] || 0) + (+i.amount || 0); });
    var cats = Object.keys(byCat).sort(function (a, b) { return byCat[b] - byCat[a]; });
    var palette = ['#ff7a18', '#0f5132', '#e11d48', '#ffb347', '#7c5cd6', '#16a34a', '#6b6560'];
    chart('mnInvChart', {
      type: 'doughnut',
      data: {
        labels: cats,
        datasets: [{ data: cats.map(function (c) { return byCat[c]; }), backgroundColor: cats.map(function (_, i) { return palette[i % palette.length]; }), borderColor: '#fff', borderWidth: 3, hoverOffset: 8 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true, font: { size: 10.5, weight: '600' } } },
          tooltip: { backgroundColor: '#1b1a19', padding: 10, cornerRadius: 8, callbacks: { label: function (c) { var t = sum(cats.map(function (x) { return byCat[x]; })); return c.label + ': ' + inr(c.parsed) + ' (' + pct(t ? c.parsed / t * 100 : 0) + ')'; } } }
        }
      }
    });
  }

  /* ============================================================ order no. ==
     An OPTIONAL Swiggy reference, shown everywhere as #XXXX — the hash plus
     exactly four digits. It is stored on the row as `orderNo` WITHOUT the hash
     (the hash is a display prefix, added by the table, describeRow and the
     invoice), shown in the master table's "Order no." column, and printed on
     the invoice. Blank is allowed and means "no number". */
  function normalizeOrderNo(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\s+/g, '');
    if (s.charAt(0) === '#') s = s.slice(1);
    if (!s) return { ok: true, value: '' };                       /* optional */
    if (!/^\d{4}$/.test(s)) return { ok: false, value: s };
    return { ok: true, value: s };
  }

  /* ============================================================== invoices ==
     Every order \u2014 Swiggy or offline \u2014 can be turned into a printed invoice.
     The invoice is drawn on a <canvas> (2x for print), the preview shows that
     canvas, and the download buttons give you
       \u2022 PNG  \u2014 the canvas as an image, and
       \u2022 PDF  \u2014 the same image placed on a single A4 page.
     Nothing here talks to the network and nothing is read from the writer, so
     it behaves identically on the hosted site and on a local copy. It also
     never writes data \u2014 which is why the button is NOT a .readonly-hide
     control and stays available in live mode. */

  var A4 = { w: 595.28, h: 841.89 };          /* A4 portrait, in points       */
  var INV_SCALE = 2;                          /* canvas pixels per point      */
  var INV_FONT = '"Segoe UI", Inter, Arial, Helvetica, sans-serif';
  var INV_INK = '#1b1a19', INV_SOFT = '#6b6560', INV_FAINT = '#8c857e';
  var INV_LINE = '#cfc8c0', INV_BORDER = '#e6e0da', INV_TINT = '#fff7ef', INV_ORANGE = '#f26100';
  var INV_PAD = 40, INV_INNER = 22;

  var invoiceTarget = null;                   /* {kind, row, model} */

  /* ------------------------------------------------------------- the logo
     `assets/logo.js` carries the Babyz Pizza logo as a base64 data URI
     (built by tools/make-logo.js). It is EMBEDDED rather than linked for one
     concrete reason: a file:// image drawn onto a canvas taints it, and a
     tainted canvas cannot be exported \u2014 so on a double-clicked index.html
     every PNG and PDF download would fail. A data URI is same-origin, so the
     canvas stays clean everywhere.

     It is also loaded LAZILY \u2014 the dashboard never pays for it, it arrives
     the first time an invoice is opened, and if it is missing the invoice
     falls back to the drawn mark instead of breaking. */
  var logoState = { status: 'idle', img: null, waiters: [] };

  function withInvoiceLogo(cb) {
    if (logoState.status === 'done') { cb(logoState.img); return; }
    logoState.waiters.push(cb);
    if (logoState.status === 'loading') return;
    logoState.status = 'loading';

    function finish(img) {
      logoState.status = 'done';
      logoState.img = img;
      var queued = logoState.waiters.slice();
      logoState.waiters.length = 0;
      queued.forEach(function (fn) { fn(img); });
    }

    function decode() {
      var src = typeof window.BABYZ_LOGO === 'string' ? window.BABYZ_LOGO : '';
      if (!src) { finish(null); return; }
      var img = new Image();
      img.onload = function () { finish(img); };
      img.onerror = function () { finish(null); };
      img.src = src;
    }

    if (typeof window.BABYZ_LOGO === 'string') { decode(); return; }

    var tag = document.createElement('script');
    tag.src = 'assets/logo.js';
    tag.onload = decode;
    tag.onerror = function () {
      console.warn('babyz: assets/logo.js did not load \u2014 invoices will use the drawn mark. Run `node tools/make-logo.js` to rebuild it.');
      finish(null);
    };
    document.head.appendChild(tag);
  }

  /* -------------------------------------------------- canvas text helpers */
  function invFont(size, weight) { return (weight || 400) + ' ' + size + 'px ' + INV_FONT; }

  function invWidth(ctx, s, size, weight) {
    ctx.font = invFont(size, weight);
    return ctx.measureText(String(s)).width;
  }

  /* canvas has no letter-spacing everywhere yet, so wide-tracked labels are
     drawn one glyph at a time \u2014 that also keeps them centred exactly */
  function invSpaced(ctx, s, x, y, spacing, align) {
    var i, total = 0, cx;
    ctx.textAlign = 'left';
    for (i = 0; i < s.length; i++) total += ctx.measureText(s[i]).width + (i ? spacing : 0);
    cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    for (i = 0; i < s.length; i++) {
      ctx.fillText(s[i], cx, y);
      cx += ctx.measureText(s[i]).width + spacing;
    }
  }

  /* o = { size, weight, color, align, spacing, upper } */
  function invText(ctx, s, x, y, o) {
    o = o || {};
    var text = String(s === undefined || s === null ? '' : s);
    if (o.upper) text = text.toUpperCase();
    ctx.font = invFont(o.size || 11, o.weight || 400);
    ctx.fillStyle = o.color || INV_INK;
    ctx.textBaseline = 'alphabetic';
    if (o.spacing) { invSpaced(ctx, text, x, y, o.spacing, o.align || 'left'); return; }
    ctx.textAlign = o.align || 'left';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  }

  function invClip(ctx, s, maxW, size, weight) {
    var t = String(s === undefined || s === null ? '' : s);
    if (invWidth(ctx, t, size, weight) <= maxW) return t;
    while (t.length > 1 && invWidth(ctx, t + '\u2026', size, weight) > maxW) t = t.slice(0, -1);
    return t + '\u2026';
  }

  function invWrap(ctx, s, maxW, size, weight, maxLines) {
    ctx.font = invFont(size, weight);
    var words = String(s === undefined || s === null ? '' : s).split(/\s+/).filter(Boolean);
    var lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; }
      else cur = t;
    });
    if (cur) lines.push(cur);
    if (!lines.length) lines = [''];
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = invClip(ctx, lines[maxLines - 1] + ' \u2026', maxW, size, weight);
    }
    return lines;
  }

  function invRule(ctx, x1, x2, y, w, color) {
    ctx.save();
    ctx.strokeStyle = color || INV_LINE;
    ctx.lineWidth = w || 1;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.restore();
  }

  function invDash(ctx, x1, x2, y) {
    ctx.save();
    ctx.strokeStyle = INV_LINE; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
    ctx.restore();
  }

  function invRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------ Code 39 for the footer
     The reference receipt ends in a barcode, so the invoice does too: the
     order reference encoded as Code 39 (9 elements per character \u2014 five bars
     and four spaces, exactly three of them wide). Every pattern is validated
     before it is drawn, so a bad table entry can never produce a broken strip. */
  var CODE39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
    '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
    'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn',
    'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn',
    'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn',
    'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn',
    'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
  };

  function code39Pattern(ch) {
    var pat = CODE39[ch];
    if (!pat || pat.length !== 9) return null;
    var wide = 0, i;
    for (i = 0; i < 9; i++) {
      if (pat[i] !== 'n' && pat[i] !== 'w') return null;
      if (pat[i] === 'w') wide++;
    }
    return wide === 3 ? pat : null;      /* always exactly 3 wide elements */
  }

  /* the barcode value: the order reference, uppercased and restricted to the
     Code 39 character set (returns '' when nothing usable is left) */
  function code39Value(raw) {
    return String(raw || '').toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '');
  }

  function code39Modules(value) {
    var s = code39Value(value);
    if (!s) return '';
    var chars = ('*' + s + '*').split('');
    var out = '';
    for (var c = 0; c < chars.length; c++) {
      var pat = code39Pattern(chars[c]);
      if (!pat) return '';
      if (c) out += '0';                              /* one narrow gap */
      for (var j = 0; j < 9; j++) {
        var bit = (j % 2 === 0) ? '1' : '0';          /* bars at 0,2,4,6,8 */
        var n = pat[j] === 'w' ? 3 : 1;
        for (var k = 0; k < n; k++) out += bit;
      }
    }
    return out;
  }

  function drawBarcode(ctx, value, centerX, bottomY, maxW, h) {
    var mods = code39Modules(value);
    if (!mods) return false;
    var mw = Math.min(2, maxW / mods.length);
    if (mw < 0.45) return false;                      /* too dense to read */
    var x = centerX - (mods.length * mw) / 2;
    ctx.save();
    ctx.fillStyle = INV_INK;
    for (var i = 0; i < mods.length; i++) {
      if (mods[i] === '1') ctx.fillRect(x + i * mw, bottomY - h, mw + 0.3, h);
    }
    ctx.restore();
    return true;
  }

  /* ------------------------------------------------------------- the model */
  function invoiceRef(kind, row) {
    var typed = kind === 'swiggy' ? (row.orderNo || '') : '';
    return String(typed ? '#' + typed : (row.id || ''));
  }

  /* The invoice's generated date IS the order's date. An order records a date but
     never a time, so no clock time is printed \u2014 it would be today's, which would
     contradict the date sitting next to it. dNice() keeps this line reading
     exactly like the Date field higher up the invoice. */
  function invStamp(date) {
    return 'Generated ' + dNice(date);
  }

  /* every field of the order, laid out the way the reference receipt reads.
     One entry in `items` per pizza, so a multi-pizza order prints as a proper
     multi-line bill \u2014 the layout already loops over this array. */
  function invoiceModel(kind, row) {
    var isSw = kind === 'swiggy';
    var lines = rowLines(row, kind).map(function (l) {
      return Object.assign({}, l, {
        line: l.qty * l.price,
        cat: resolveCategory(kind, l.item, row.category)
      });
    });
    var qty = sum(lines, function (l) { return l.qty; });
    var subtotal = sum(lines, function (l) { return l.line; });
    var discount = isSw ? 0 : (+row.offerAmount || 0);
    var total = isSw ? subtotal : (row.final === undefined ? subtotal - discount : +row.final);
    var ref = invoiceRef(kind, row);

    /* a mixed order has no single type, so don't pretend it does */
    var cats = lines.map(function (l) { return l.cat; });
    var mixed = cats.some(function (c) { return c !== cats[0]; });
    var cat = mixed ? 'Mixed' : (CAT_LABEL[cats[0]] || '\u2014');

    var totals = [{ k: 'Subtotal', v: inr(subtotal, 2) }];
    if (discount > 0) totals.push({ k: 'Discount', v: '\u2212' + inr(discount, 2) });
    totals.push({ k: isSw ? 'Total paid' : 'Total', v: inr(total, 2), strong: true });

    return {
      ref: ref,
      brand: {
        name: state.data.meta.business || 'Babyz Pizza',
        place: state.data.meta.channel || 'Garia, Kolkata'
      },
      metaLeft: [
        /* "Order no." only when one was actually typed; otherwise the row's own
           id is shown, and calling that an order number would be a stretch */
        { k: (kind === 'swiggy' && row.orderNo) ? 'Order no.' : 'Bill ref.', v: ref },
        { k: 'Date', v: dNice(row.date) },
        { k: 'Customer', v: row.customer || '\u2014' }
      ],
      metaRight: [
        { k: 'Channel', v: isSw ? 'Swiggy \u00B7 online' : 'Walk-in \u00B7 offline' },
        { k: 'Type', v: cat },
        { k: 'Quantity', v: String(qty) }
      ],
      items: lines.map(function (l) {
        return {
          name: (l.qty > 1 ? l.qty + ' \u00D7 ' : '') + (l.item || '\u2014'),
          line: inr(l.line, 2),
          sub: inr(l.price, 2) + ' each \u00B7 ' + (CAT_LABEL[l.cat] || '\u2014') +
            (isSw ? ' \u00B7 paid to Swiggy' : (discount > 0 ? ' \u00B7 offer applied' : ''))
        };
      }),
      totals: totals,
      note: row.note || '',
      footer: 'THANK YOU FOR ORDERING WITH US!',
      barcode: ref,
      stamp: (state.data.meta.business || 'Babyz Pizza') + ' \u00B7 ' +
        (state.data.meta.channel || '') + ' \u00B7 ' + invStamp(row.date)
    };
  }

  /* ------------------------------------------------------------- the layout */
  function drawInvoice(canvas, m) {
    var W = A4.w, H = A4.h;
    canvas.width = Math.round(W * INV_SCALE);
    canvas.height = Math.round(H * INV_SCALE);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(INV_SCALE, 0, 0, INV_SCALE, 0, 0);   /* draw in points */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    var bx = INV_PAD, by = INV_PAD;
    var bw = W - INV_PAD * 2, bh = H - INV_PAD * 2;
    var cx = bx + INV_INNER, cw = bw - INV_INNER * 2, xr = cx + cw;

    /* the receipt frame */
    ctx.save();
    ctx.strokeStyle = INV_BORDER; ctx.lineWidth = 1;
    invRoundRect(ctx, bx + .5, by + .5, bw - 1, bh - 1, 12);
    ctx.stroke();
    ctx.restore();

    var y = by + INV_INNER;

    /* ---- brand: the real logo when it is available ---- */
    var ms = 74;
    if (m.logo) {
      /* the artwork is white-backed, so it sits straight on the page */
      ctx.drawImage(m.logo, W / 2 - ms / 2, y, ms, ms);
    } else {
      /* no logo file: the drawn tile from before */
      var grd = ctx.createLinearGradient(W / 2 - 46 / 2, y, W / 2 + 46 / 2, y + 46);
      grd.addColorStop(0, '#ffb347'); grd.addColorStop(.55, '#ff7a18'); grd.addColorStop(1, '#f26100');
      ctx.save(); ctx.fillStyle = grd;
      invRoundRect(ctx, W / 2 - 23, y, 46, 46, 13);
      ctx.fill(); ctx.restore();
      invText(ctx, '\uD83C\uDF55', W / 2, y + 32, { size: 24, align: 'center' });
    }
    y += ms + 26;

    /* the logo carries the name and the tagline in its own artwork, so only the
       readable typeset name and the place are set here */
    invText(ctx, m.brand.name, W / 2, y, { size: 23, weight: 800, align: 'center', spacing: 3.2, upper: true });
    y += 16;
    invText(ctx, m.brand.place, W / 2, y, { size: 9.4, align: 'center', color: INV_FAINT });
    y += 18;
    invDash(ctx, cx, xr, y);
    y += 24;

    /* ---- title ---- */
    invText(ctx, 'Invoice', W / 2, y, { size: 12, weight: 800, align: 'center', spacing: 4.5, upper: true });
    invRule(ctx, W / 2 - 74, W / 2 - 46, y - 4, 1);
    invRule(ctx, W / 2 + 46, W / 2 + 74, y - 4, 1);
    y += 27;

    /* ---- order details, two columns ---- */
    var rows = Math.max(m.metaLeft.length, m.metaRight.length);
    var half = cw / 2 - 16;
    for (var i = 0; i < rows; i++) {
      var L = m.metaLeft[i], R = m.metaRight[i];
      if (L) {
        invText(ctx, L.k, cx, y, { size: 8.2, weight: 800, spacing: 1.2, color: INV_FAINT, upper: true });
        invText(ctx, invClip(ctx, L.v, half, 11, 700), cx, y + 15, { size: 11, weight: 700 });
      }
      if (R) {
        invText(ctx, R.k, xr, y, { size: 8.2, weight: 800, spacing: 1.2, color: INV_FAINT, align: 'right', upper: true });
        invText(ctx, invClip(ctx, R.v, half, 11, 700), xr, y + 15, { size: 11, weight: 700, align: 'right' });
      }
      y += 33;
    }

    /* ---- item(s) ---- */
    y += 4;
    invDash(ctx, cx, xr, y);
    y += 20;
    invText(ctx, 'Item', cx, y, { size: 8.2, weight: 800, spacing: 1.4, color: INV_FAINT, upper: true });
    invText(ctx, 'Amount', xr, y, { size: 8.2, weight: 800, spacing: 1.4, color: INV_FAINT, align: 'right', upper: true });
    y += 8;
    invRule(ctx, cx, xr, y);
    y += 20;

    /* a multi-pizza order needs more vertical room than a single-pizza one, so
       tighten the row pitch once the list gets long \u2014 and if the content still
       overruns, the footer block below is pushed down to make space for it */
    var many = m.items.length > 6;
    var lh = many ? 12.5 : 14.5;
    var subGap = many ? 12 : 14;
    var rowGap = many ? 19 : 24;
    var nameSize = many ? 10.8 : 11.6;

    m.items.forEach(function (it) {
      var lines = invWrap(ctx, it.name, cw - 150, nameSize, 700, 2);
      for (var k = 0; k < lines.length; k++) {
        invText(ctx, lines[k], cx, y + k * lh, { size: nameSize, weight: 700 });
      }
      invText(ctx, it.line, xr, y, { size: nameSize, weight: 700, align: 'right' });
      var subY = y + (lines.length - 1) * lh + subGap;
      invText(ctx, invClip(ctx, it.sub, cw - 150, 9.2, 400), cx, subY, { size: 9.2, color: INV_SOFT });
      y = subY + rowGap;
    });

    /* ---- money ---- */
    invRule(ctx, cx, xr, y - 6);
    y += 14;
    m.totals.forEach(function (t) {
      if (t.strong) {
        invRule(ctx, xr - 210, xr, y - 13, 1.4, INV_INK);
        invText(ctx, t.k, xr - 130, y, { size: 12, weight: 800, align: 'right' });
        invText(ctx, t.v, xr, y, { size: 15, weight: 800, align: 'right' });
        y += 26;
      } else {
        invText(ctx, t.k, xr - 130, y, { size: 10.6, weight: 600, align: 'right', color: INV_SOFT });
        invText(ctx, t.v, xr, y, { size: 11.4, weight: 700, align: 'right' });
        y += 19;
      }
    });

    /* ---- note ---- */
    if (m.note) {
      var nl = invWrap(ctx, m.note, cw - 24, 10.4, 600, 3);
      var nh = 38 + (nl.length - 1) * 14;
      ctx.save();
      ctx.fillStyle = INV_TINT;
      invRoundRect(ctx, cx, y - 6, cw, nh, 8);
      ctx.fill();
      ctx.strokeStyle = '#ffe0c2'; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
      invText(ctx, 'Note', cx + 12, y + 10, { size: 8.2, weight: 800, spacing: 1.2, color: INV_ORANGE, upper: true });
      for (var n = 0; n < nl.length; n++) {
        invText(ctx, nl[n], cx + 12, y + 26 + n * 14, { size: 10.4, weight: 600 });
      }
      y += nh + 4;
    }

    /* ---- footer, anchored to the bottom of the frame ---- */
    var barH = 42, maxBarW = Math.min(300, cw);
    var stampY = by + bh - INV_INNER;
    var barNumY = stampY - 17;
    var barBottom = barNumY - 13;
    var thanksY = barBottom - barH - 24;
    var ruleY = thanksY - 24;
    if (y + 16 > ruleY) {                            /* unusually tall content */
      var push = (y + 16) - ruleY;
      ruleY += push; thanksY += push; barBottom += push; barNumY += push; stampY += push;
    }

    invDash(ctx, cx, xr, ruleY);
    invText(ctx, m.footer, W / 2, thanksY, { size: 10.4, weight: 800, align: 'center', spacing: 1.8 });
    var drew = drawBarcode(ctx, m.barcode, W / 2, barBottom, maxBarW, barH);
    if (drew) {
      invText(ctx, code39Value(m.barcode), W / 2, barNumY, { size: 8.6, weight: 700, align: 'center', spacing: 1.6, color: INV_SOFT });
    }
    invText(ctx, invClip(ctx, m.stamp, cw, 7.8, 400), W / 2, stampY, { size: 7.8, align: 'center', color: INV_FAINT });

    return canvas;
  }

  /* ------------------------------------------------------------- the files */
  function invoiceFileBase(m) {
    var s = String((m && m.ref) || 'order').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return 'Babyz-Pizza-Invoice-' + (s || 'order');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }

  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 4000);
  }

  function downloadInvoicePNG() {
    if (!invoiceTarget) return;
    var cv = $('invoiceCanvas'), name = invoiceFileBase(invoiceTarget.model) + '.png';
    if (cv.toBlob) {
      cv.toBlob(function (blob) {
        if (blob) downloadBlob(blob, name); else downloadDataUrl(cv.toDataURL('image/png'), name);
      }, 'image/png');
    } else {
      downloadDataUrl(cv.toDataURL('image/png'), name);
    }
  }

  /* A minimal single-page PDF: the invoice JPEG (DCTDecode) filling one A4
     page. Written by hand so there is no library to load and no CDN to reach —
     which is what makes the download work on the hosted site too. */
  function pdfFromCanvas(cv) {
    var b64 = cv.toDataURL('image/jpeg', 0.94).split(',')[1];
    var bin = atob(b64), jpeg = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i) & 0xff;

    var W = A4.w, H = A4.h;
    var f = function (n) { return (Math.round(n * 100) / 100).toString(); };
    var parts = [], offsets = [], total = 0;

    function pushStr(s) {
      var b = new Uint8Array(s.length), k;
      for (k = 0; k < s.length; k++) b[k] = s.charCodeAt(k) & 0xff;
      parts.push(b); total += b.length;
    }
    function pushBuf(b) { parts.push(b); total += b.length; }
    function obj(n, body) { offsets[n] = total; pushStr(n + ' 0 obj\n' + body + '\nendobj\n'); }

    pushStr('%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n');

    var content = 'q ' + f(W) + ' 0 0 ' + f(H) + ' 0 0 cm /Im0 Do Q\n';
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(W) + ' ' + f(H) +
      '] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
    obj(4, '<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream');

    offsets[5] = total;
    pushStr('5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + cv.width + ' /Height ' + cv.height +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length +
      ' >>\nstream\n');
    pushBuf(jpeg);
    pushStr('\nendstream\nendobj\n');

    var xrefAt = total;
    var xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (var n = 1; n <= 5; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
    pushStr(xref);
    pushStr('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

    return new Blob(parts, { type: 'application/pdf' });
  }

  function downloadInvoicePDF() {
    if (!invoiceTarget) return;
    var cv = $('invoiceCanvas'), name = invoiceFileBase(invoiceTarget.model) + '.pdf';
    try {
      downloadBlob(pdfFromCanvas(cv), name);
    } catch (e) {
      console.error(e);
      toast('This browser could not build the PDF \u2014 use Download PNG instead.', 'err');
    }
  }

  /* ------------------------------------------------------------- the window */
  function findOrderRow(collection, id) {
    var rows = collection === 'swiggyOrders' ? swiggyRows() : offlineRows();
    for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i];
    return null;
  }

  /* Works in every mode \u2014 including the hosted, read-only copy. Nothing is
     written, so this deliberately does not go through guardWrite(). */
  function openInvoice(collection, id) {
    var kind = collection === 'swiggyOrders' ? 'swiggy' : 'offline';
    var row = findOrderRow(collection, id);
    if (!row) { toast('That order is not in the loaded data any more.', 'err'); return; }

    withInvoiceLogo(function (logo) {
      var model = invoiceModel(kind, row);
      model.logo = logo;
      drawInvoice($('invoiceCanvas'), model);
      invoiceTarget = { kind: kind, row: row, model: model };

      $('invoiceTitle').textContent = (kind === 'swiggy' ? 'Swiggy order' : 'Offline order') +
        ' invoice \u00B7 ' + model.ref;
      $('invoiceBackdrop').hidden = false;
      setTabScrollLock(true);
    });
  }

  function closeInvoice() {
    $('invoiceBackdrop').hidden = true;
    invoiceTarget = null;
    setTabScrollLock(false);
  }

  /* the preview is a full-A4 canvas, so stop the page behind it scrolling */
  function setTabScrollLock(on) {
    document.body.style.overflow = on ? 'hidden' : '';
  }

  /* ------------------------------------------------------------ render all */
  var activeTab = 'swiggy';

  function renderChartsForTab(tab) {
    if (tab === 'swiggy') renderSwiggyCharts();
    else if (tab === 'offline') renderOfflineCharts();
    else if (tab === 'money') renderMoneyCharts();
  }

  function renderAll() {
    renderKPIs();
    renderFilters();
    renderPayoutWeekPicker();
    renderSettings();
    renderTables();
    renderMenus();
    renderPendingBar();
    renderChartsForTab(activeTab);
  }

  /* ------------------------------------------------------------ events */
  var wired = false;

  function wireEvents() {
    if (wired) return;
    wired = true;

    /* tabs */
    qsa('#tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () {
        qsa('#tabs .tab').forEach(function (x) { x.classList.remove('active'); });
        qsa('.panel').forEach(function (p) { p.classList.remove('active'); });
        b.classList.add('active');
        activeTab = b.dataset.tab;
        $('panel-' + activeTab).classList.add('active');
        renderChartsForTab(activeTab);
      });
    });

    /* filters */
    function bindFilter(id, scope, key, evt) {
      $(id).addEventListener(evt || 'change', function () {
        state.filters[scope][key] = this.value;
        renderKPIs(); renderTables(); renderChartsForTab(activeTab);
      });
    }
    bindFilter('swFrom', 'swiggy', 'from'); bindFilter('swTo', 'swiggy', 'to');
    bindFilter('swItem', 'swiggy', 'item'); bindFilter('swCat', 'swiggy', 'cat');
    bindFilter('swQ', 'swiggy', 'q', 'input');
    bindFilter('ofFrom', 'offline', 'from'); bindFilter('ofTo', 'offline', 'to');
    bindFilter('ofItem', 'offline', 'item'); bindFilter('ofCat', 'offline', 'cat');
    bindFilter('ofQ', 'offline', 'q', 'input');

    $('swReset').addEventListener('click', function () {
      state.filters.swiggy = { from: '', to: '', item: '', cat: '', q: '' };
      renderAll();
    });
    $('ofReset').addEventListener('click', function () {
      state.filters.offline = { from: '', to: '', item: '', cat: '', q: '' };
      renderAll();
    });

    /* add: swiggy order \u2014 one row, as many pizzas as were actually ordered */
    $('swAddBtn').addEventListener('click', function () {
      var picked = readLinesEditor($('swLines'));
      if (!picked.ok) { toast(picked.error, 'err'); return; }

      /* the order number is OPTIONAL — if one is typed it must be # + 4 digits */
      var orderNo = normalizeOrderNo($('swOrderNoAdd').value);
      if (!orderNo.ok) {
        toast('Order no. must be # followed by exactly 4 digits (e.g. #1234) \u2014 or leave it blank.', 'err');
        $('swOrderNoAdd').focus();
        return;
      }

      addRow('swiggyOrders', Object.assign(linesSummary(picked.lines, 'swiggy'), {
        id: uid('swg'), date: $('swDateAdd').value || todayISO(),
        orderNo: orderNo.value,
        customer: $('swCustomerAdd').value.trim() || 'Random',
        sellingPrice: picked.lines[0].price,
        lines: picked.lines,
        note: $('swNoteAdd').value.trim()
      }));

      /* clear the form but keep the date \u2014 several orders usually share a day */
      $('swOrderNoAdd').value = '';
      $('swCustomerAdd').value = ''; $('swNoteAdd').value = '';
      renderLinesEditor($('swLines'), 'swiggy', null);
    });

    /* add: payout — start day from the calendar, end date derived, overlaps merged */
    $('swpStart').addEventListener('change', updatePayoutEndPreview);
    $('swpStart').addEventListener('input', updatePayoutEndPreview);

    $('swpAddBtn').addEventListener('click', function () {
      if (!guardWrite()) return;

      var start = $('swpStart').value;
      var amount = parseFloat($('swpAmount').value);
      if (!start) { toast('Pick the week start day from the calendar first.', 'err'); return; }
      if (start < WEEK_MIN_START) { toast('Weeks can only start on or after 1 Sep 2026.', 'err'); return; }
      if (isNaN(amount)) { toast('Enter the payout amount received.', 'err'); return; }

      var newRange = { start: start, end: payoutWeekEnd(start) };
      var note = $('swpNote').value.trim();
      var received = $('swpReceived').value || '';

      /* compare against the authoritative set (not the filtered view) */
      var hits = state.base.swiggyPayouts.filter(function (p) {
        return rangesOverlap(newRange, payoutRange(p));
      });

      if (!hits.length) {
        addRow('swiggyPayouts', {
          id: uid('pay'), weekStart: start, weekEnd: newRange.end,
          payout: amount, receivedOn: received, note: note
        });
        toast('Added week ' + rangeLabel(start, newRange.end) + '.', 'ok');
      } else {
        /* merge: union of every overlapping range, payout amounts summed */
        var union = newRange, total = amount, merged = 1, notes = [];
        var ids = [];
        hits.forEach(function (p) {
          union = mergeRanges(union, payoutRange(p));
          total += (+p.payout || 0);
          merged += (+p.mergedFrom || 1);
          if (p.note) notes.push(p.note);
          ids.push(p.id);
        });
        if (note) notes.push(note);
        if (!received && hits[0].receivedOn) received = hits[0].receivedOn;

        ['base', 'data'].forEach(function (which) {
          state[which].swiggyPayouts = state[which].swiggyPayouts.filter(function (p) {
            return ids.indexOf(p.id) < 0;
          });
        });
        /* any staged deletion of a row we just absorbed is no longer relevant */
        state.pending = state.pending.filter(function (x) {
          return !(x.collection === 'swiggyPayouts' && ids.indexOf(x.id) >= 0);
        });

        addRow('swiggyPayouts', {
          id: ids[0],
          weekStart: union.start, weekEnd: union.end,
          payout: +total.toFixed(2), receivedOn: received,
          note: notes.join(' \u00B7 '), mergedFrom: merged
        });
        toast('Overlapped ' + hits.length + ' existing week' + (hits.length === 1 ? '' : 's') +
          ' \u2014 merged into ' + rangeLabel(union.start, union.end) + ' = ' + inr(total, 2), 'ok');
      }

      $('swpStart').value = '';
      $('swpAmount').value = ''; $('swpNote').value = ''; $('swpReceived').value = '';
      updatePayoutEndPreview();
    });

    /* add: offline order \u2014 one row, as many pizzas as were actually ordered */
    $('ofAddBtn').addEventListener('click', function () {
      var picked = readLinesEditor($('ofLines'));
      if (!picked.ok) { toast(picked.error, 'err'); return; }
      var offer = parseFloat($('ofOfferAdd').value) || 0;
      addRow('offlineOrders', Object.assign(linesSummary(picked.lines, 'offline'), {
        id: uid('off'), date: $('ofDateAdd').value || todayISO(),
        customer: $('ofCustomerAdd').value.trim() || 'Walk-in',
        rate: picked.lines[0].price,
        lines: picked.lines,
        offer: offer > 0, offerAmount: offer,
        note: $('ofNoteAdd').value.trim()
      }));
      $('ofCustomerAdd').value = ''; $('ofOfferAdd').value = 0; $('ofNoteAdd').value = '';
      renderLinesEditor($('ofLines'), 'offline', null);
    });

    /* add: investment */
    $('invAddBtn').addEventListener('click', function () {
      var qty = parseFloat($('invQtyAdd').value) || 1;
      var rate = parseFloat($('invRateAdd').value) || 0;
      var item = $('invItemAdd').value.trim();
      if (!item) { toast('Enter what was bought.', 'err'); return; }
      addRow('investments', {
        id: uid('inv'), date: $('invDateAdd').value || todayISO(),
        dateLabel: '', item: item, qty: qty, rate: rate,
        amount: +(qty * rate).toFixed(2), category: $('invCatAdd').value, note: ''
      });
      $('invItemAdd').value = ''; $('invRateAdd').value = ''; $('invQtyAdd').value = 1;
    });

    /* settings */
    $('saveSettingsBtn').addEventListener('click', function () {
      state.base.meta.settings.costPerPizza = parseFloat($('costPerPizza').value) || 0;
      state.base.meta.settings.applyCostToSwiggy = $('applyCostSwiggy').value === 'yes';
      state.data.meta.settings = clone(state.base.meta.settings);
      writeAll().then(function (res) { if (res && res.ok) renderAll(); });
    });

    /* delete (delegated) -> always through the confirm popup */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-del]') : null;
      if (!btn) return;
      requestDelete(btn.dataset.del, btn.dataset.id);
    });

    /* menu add / move / delete -> each through its own confirm popup */
    ['offline', 'swiggy'].forEach(function (ch) {
      $('menuAddBtn-' + ch).addEventListener('click', function () { requestMenuAdd(ch); });
      $('menuGroup-' + ch).addEventListener('change', function () { syncMenuGroupForm(ch); });
    });

    document.addEventListener('click', function (e) {
      if (!e.target.closest) return;
      var ec = e.target.closest('[data-edit-customer]');
      if (ec) { requestCustomerEdit(ec.dataset.editCustomer, ec.dataset.id); return; }
      var ei = e.target.closest('[data-edit-investment]');
      if (ei) { requestInvestmentEdit(ei.dataset.editInvestment); return; }
      var eo = e.target.closest('[data-edit-order-no]');
      if (eo) { requestOrderNoEdit(eo.dataset.editOrderNo); return; }
      var el = e.target.closest('[data-edit-lines]');
      if (el) { requestItemsEdit(el.dataset.editLines, el.dataset.id); return; }
      var mv = e.target.closest('[data-menu-move]');
      if (mv) { requestMenuMove(mv.dataset.menuMove, mv.dataset.menuName); return; }
      var dl = e.target.closest('[data-menu-del]');
      if (dl) { requestMenuDelete(dl.dataset.menuDel, dl.dataset.menuName); }
    });

    /* modal */
    $('modalOk').addEventListener('click', function () {
      var fn = modalConfirmFn;
      closeModal();
      if (fn) fn();
    });
    $('modalCancel').addEventListener('click', closeModal);
    $('modalBackdrop').addEventListener('click', function (e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('invoiceBackdrop').hidden) { closeInvoice(); return; }
      if (!$('modalBackdrop').hidden) closeModal();
    });

    /* invoices: open the preview from any row, then download it */
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-invoice]') : null;
      if (!btn) return;
      openInvoice(btn.dataset.invoice, btn.dataset.id);
    });
    $('invoiceClose').addEventListener('click', closeInvoice);
    $('invoiceBackdrop').addEventListener('click', function (e) { if (e.target === this) closeInvoice(); });
    $('invoicePdf').addEventListener('click', downloadInvoicePDF);
    $('invoicePng').addEventListener('click', downloadInvoicePNG);

    /* staged deletions */
    $('undoDeleteBtn').addEventListener('click', requestUndo);
    $('confirmDeleteBtn').addEventListener('click', requestConfirmDeletes);

    /* reload from the repo copy */
    $('reloadBtn').addEventListener('click', function () { location.reload(); });

    /* enter to add */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (!t || t.tagName !== 'INPUT' || !t.id) return;
      var menuMap = { 'menuName-offline': 'menuAddBtn-offline', 'menuPrice-offline': 'menuAddBtn-offline',
                      'menuName-swiggy': 'menuAddBtn-swiggy', 'menuPrice-swiggy': 'menuAddBtn-swiggy' };
      if (menuMap[t.id]) { e.preventDefault(); $(menuMap[t.id]).click(); return; }
      if (t.id === 'customerEditInput') { e.preventDefault(); $('modalOk').click(); return; }
      if (/Add$/.test(t.id)) {
        var map = {
          swCustomerAdd: 'swAddBtn', swNoteAdd: 'swAddBtn', swOrderNoAdd: 'swAddBtn',
          ofCustomerAdd: 'ofAddBtn', ofOfferAdd: 'ofAddBtn', ofNoteAdd: 'ofAddBtn',
          invItemAdd: 'invAddBtn', invQtyAdd: 'invAddBtn', invRateAdd: 'invAddBtn',
          swpAmount: 'swpAddBtn', swpNote: 'swpAddBtn'
        };
        if (map[t.id]) { e.preventDefault(); $(map[t.id]).click(); }
      }
    });
  }

  /* ------------------------------------------------------------ go */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
