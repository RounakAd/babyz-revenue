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
    toast('Read-only: this hosted copy cannot be edited. Open the site locally to add or delete rows.', 'err');
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
        else toast('Save failed: ' + ((res && res.error) || 'unknown error'), 'err');
        return res || { ok: false };
      });
  }

  /* delete -> STAGE only */
  function writeStage() {
    if (!guardWrite()) return Promise.resolve({ ok: false });
    if (state.mode === 'draft') return saveDraft();
    return postJSON('/api/stage', { view: state.data, pending: state.pending })
      .then(function (res) {
        if (!res || !res.ok) toast('Could not stage the deletion: ' + ((res && res.error) || 'unknown error'), 'err');
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
      if (!res || !res.ok) { toast('Undo failed: ' + ((res && res.error) || 'unknown error'), 'err'); return; }
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
      if (!res || !res.ok) { toast('Confirm failed: ' + ((res && res.error) || 'unknown error'), 'err'); return; }
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
      return (row.item || '') + ' \u00B7 ' + dNice(row.date) + ' \u00B7 ' + (row.customer || '\u2014') +
        ' \u00B7 ' + inr((+row.rate || 0) * (+row.qty || 0) - (+row.offerAmount || 0));
    }
    if (collection === 'swiggyOrders') {
      return (row.item || '') + ' \u00B7 ' + dNice(row.date) + ' \u00B7 ' + (row.customer || '\u2014') +
        ' \u00B7 ' + inr((+row.sellingPrice || 0) * (+row.qty || 0));
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

  /* ------------------------------------------------------------ computed rows */
  function offlineRows() {
    var cpp = +settings().costPerPizza || 0;
    return state.data.offlineOrders.map(function (o) {
      var rate = +o.rate || 0, qty = +o.qty || 0, offer = +o.offerAmount || 0;
      var amount = rate * qty, final = amount - offer, cost = cpp * qty;
      return Object.assign({}, o, {
        rate: rate, qty: qty, offer: offer, amount: amount, final: final, cost: cost, profit: final - cost,
        /* the menu is the source of truth for the category, so moving an item
           between groups re-colours its table badges and the category charts.
           A deleted item falls back to the category stored on the order. */
        category: resolveCategory('offline', o.item, o.category)
      });
    });
  }

  function swiggyRows() {
    /* weeks come from weekPeriods() \u2014 recorded payout ranges first, then the
       7-day grid \u2014 never from a hardcoded calendar */
    var periods = weekPeriods();
    return state.data.swiggyOrders.map(function (s) {
      var price = +s.sellingPrice || 0, qty = +s.qty || 0;
      var w = null;
      if (s.date) {
        for (var i = 0; i < periods.length; i++) {
          if (s.date >= periods[i].start && s.date <= periods[i].end) { w = periods[i]; break; }
        }
      }
      return Object.assign({}, s, {
        sellingPrice: price, qty: qty, gross: price * qty,
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
    if (f.cat && row.category !== f.cat) return false;
    if (f.item && row.item !== f.item) return false;
    if (f.q) {
      var hay = ((row.customer || '') + ' ' + (row.item || '') + ' ' + (row.sourceItem || '') + ' ' + (row.note || '')).toLowerCase();
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
      note.innerHTML = 'Adds write to all 3 files. Deletes stage in the 2nd local copy.';
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
        'to have adds and deletes written to the real data files.' +
        (state.draftAvailable ? ' A previously saved draft was loaded.' : '') + '</div></div>';
    } else {
      host.innerHTML = '<div class="banner lock"><span class="bico">\uD83D\uDD12</span><div><b>Read-only live copy.</b> ' +
        'Every figure on this page is read from the repo copy committed to the repository. ' +
        'Adding and deleting rows is disabled here by design \u2014 do that from the local copy, then commit &amp; push.</div></div>';
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
      body.innerHTML = '<tr><td colspan="10"><div class="empty"><span class="big">\uD83D\uDEF5</span>No Swiggy orders match the current filters.</div></td></tr>';
      foot.innerHTML = '';
    } else {
      body.innerHTML = rows.map(function (r, i) {
        return '<tr>' +
          '<td class="num mono">' + (i + 1) + '</td>' +
          '<td class="mono">' + dNice(r.date) + '</td>' +
          '<td>' + esc(r.customer || '\u2014') + '</td>' +
          '<td>' + esc(r.item) + '</td>' +
          '<td>' + catBadge(r.category) + '</td>' +
          '<td class="num mono">' + nf(r.sellingPrice) + '</td>' +
          '<td class="num mono">' + nf(r.qty) + '</td>' +
          '<td class="num mono"><b>' + inr(r.gross) + '</b></td>' +
          '<td>' + (r.week
            ? '<span class="badge ' + (r.weekSource === 'payout' ? 'warn' : 'muted') + '" title="' +
              (r.weekSource === 'payout' ? 'Recorded payout week' : 'From the 7-day grid \u2014 no payout recorded for this week yet') +
              '">' + esc(periodLabel(r.week)) + '</span>'
            : '<span class="badge muted" title="Before 1 Sep 2026 \u2014 payout weeks start here">\u2014</span>') + '</td>' +
          '<td class="actions readonly-hide"><button class="btn btn-danger" data-del="swiggyOrders" data-id="' + esc(r.id) + '">Delete</button></td>' +
          '</tr>';
      }).join('');
      foot.innerHTML = '<tr><td colspan="5">Total \u00B7 ' + nf(rows.length) + ' orders</td>' +
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
          '<td>' + esc(r.customer || '\u2014') + '</td>' +
          '<td>' + esc(r.item) + '</td>' +
          '<td>' + catBadge(r.category) + '</td>' +
          '<td class="num mono">' + nf(r.rate) + '</td>' +
          '<td class="num mono">' + nf(r.qty) + '</td>' +
          '<td class="num mono">' + nf(r.amount) + '</td>' +
          '<td class="num mono">' + (r.offer ? '<span class="neg">\u2212' + nf(r.offer) + '</span>' : '\u2014') + '</td>' +
          '<td class="num mono"><b>' + inr(r.final) + '</b></td>' +
          '<td class="num mono">' + nf(r.cost) + '</td>' +
          '<td class="num mono ' + (r.profit >= 0 ? 'pos' : 'neg') + '">' + nf(r.profit) + '</td>' +
          '<td class="actions readonly-hide"><button class="btn btn-danger" data-del="offlineOrders" data-id="' + esc(r.id) + '">Delete</button></td>' +
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
        '<td class="actions readonly-hide"><button class="btn btn-danger" data-del="investments" data-id="' + esc(r.id) + '">Delete</button></td>' +
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

    if (!$('swItemAdd').dataset.ready) { $('swItemAdd').innerHTML = itemOptions('swiggy', ''); $('swItemAdd').dataset.ready = '1'; }
    if (!$('ofItemAdd').dataset.ready) { $('ofItemAdd').innerHTML = itemOptions('offline', ''); $('ofItemAdd').dataset.ready = '1'; }
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
    rows.forEach(function (r) { byItem[r.item] = (byItem[r.item] || 0) + r.qty; });
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
    rows.forEach(function (r) { byCat[r.category] = (byCat[r.category] || 0) + r.gross; });
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
    rows.forEach(function (r) { byItem[r.item] = (byItem[r.item] || 0) + r.qty; });
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
    rows.forEach(function (r) { byCat[r.category] = (byCat[r.category] || 0) + r.final; });
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

    /* add: swiggy order */
    $('swItemAdd').addEventListener('change', function () {
      var m = menuIndex('swiggy')[this.value];
      if (m) $('swPriceAdd').value = m.price;
    });
    $('swAddBtn').addEventListener('click', function () {
      var item = $('swItemAdd').value;
      var m = menuIndex('swiggy')[item] || {};
      var price = parseFloat($('swPriceAdd').value);
      if (isNaN(price)) price = +m.price || 0;
      addRow('swiggyOrders', {
        id: uid('swg'), date: $('swDateAdd').value || todayISO(),
        customer: $('swCustomerAdd').value.trim() || 'Random',
        item: item, sourceItem: item, category: m.cat || 'veg',
        sellingPrice: price, qty: parseInt($('swQtyAdd').value, 10) || 1,
        note: $('swNoteAdd').value.trim()
      });
      $('swCustomerAdd').value = ''; $('swNoteAdd').value = ''; $('swQtyAdd').value = 1;
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

    /* add: offline order */
    $('ofItemAdd').addEventListener('change', function () {
      var m = menuIndex('offline')[this.value];
      if (m) $('ofRateAdd').value = m.price;
    });
    $('ofAddBtn').addEventListener('click', function () {
      var item = $('ofItemAdd').value;
      var m = menuIndex('offline')[item] || {};
      var rate = parseFloat($('ofRateAdd').value);
      if (isNaN(rate)) rate = +m.price || 0;
      addRow('offlineOrders', {
        id: uid('off'), date: $('ofDateAdd').value || todayISO(),
        customer: $('ofCustomerAdd').value.trim() || 'Walk-in',
        item: item, sourceItem: item, category: m.cat || 'veg',
        rate: rate, qty: parseInt($('ofQtyAdd').value, 10) || 1,
        offer: (parseFloat($('ofOfferAdd').value) || 0) > 0,
        offerAmount: parseFloat($('ofOfferAdd').value) || 0,
        note: $('ofNoteAdd').value.trim()
      });
      $('ofCustomerAdd').value = ''; $('ofOfferAdd').value = 0; $('ofQtyAdd').value = 1; $('ofNoteAdd').value = '';
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
      if (e.key === 'Escape' && !$('modalBackdrop').hidden) closeModal();
    });

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
      if (/Add$/.test(t.id)) {
        var map = {
          swCustomerAdd: 'swAddBtn', swPriceAdd: 'swAddBtn', swQtyAdd: 'swAddBtn', swNoteAdd: 'swAddBtn',
          ofCustomerAdd: 'ofAddBtn', ofRateAdd: 'ofAddBtn', ofQtyAdd: 'ofAddBtn', ofOfferAdd: 'ofAddBtn', ofNoteAdd: 'ofAddBtn',
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
