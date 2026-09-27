# Babyz Pizza revenue app — durable conventions

Vanilla-JS single-page app, no framework, no build step, no dependencies (Chart.js is vendored).
Full history lives in the dated daily logs; this file is the rules that must not be broken.

## Editing is local-only — never weaken this
* `canWrite()` = `isLocalContext() && (mode === 'server' || mode === 'draft')`. **One gate** for
  every mutation. Never add a second, independent "is live?" check.
* `isLocalContext()` is a strict allowlist: `file://`, `localhost`, `127.x.x.x`, `0.0.0.0`, `::1`,
  `*.localhost`. **No query-string escape hatch** — a `?local=1` style switch lets a hosted URL
  re-enable editing, which is exactly what must not happen.
* Any new editing UI needs **both** `.readonly-hide` (cosmetic) **and** `if (!guardWrite()) return;`
  (the real protection). The CSS alone protects nothing.
* `body.is-live` and `body.is-readonly` are both set from `!canWrite()` — keep them in sync.
* `server.js` only sends CORS headers to `Origin: null` or a loopback origin, and binds to
  `127.0.0.1`. Don't widen either.

## Two state copies — mutate both or the save silently no-ops
`state.base` is what gets written to the files; `state.data` is what renders. Row adds write both.
Menu edits go through `menuApply(fn)`, which runs the mutation against **both** and pushes a fresh
object per copy (never share a reference). Getting this wrong repaints the UI while saving nothing,
and `renderAll()` only runs on `res.ok`, so the screen looks healthy.

## The three data files
| file | role |
|---|---|
| `<Desktop>\Babyz Pizza Data\babyz-data.js` | MAIN |
| `<Desktop>\Babyz Pizza Data\babyz-data-pending.js` | STAGE (2nd copy, staged deletions) |
| `<repo>\data\babyz-data.js` | REPO — the site reads this; the one you commit |

Add → all 3. **Edit** → all 3 (same `/api/rows` path as an add). Delete → STAGE only, then
**Confirm delete** pushes STAGE → MAIN + REPO. Undo re-reads MAIN. Data format is
`window.BABYZ_DATA = {…}` **JS, not JSON** (a `<script src>` works over `file://`; `fetch()` of
JSON is CORS-blocked there).

**`/api/rows` must never write `body.view` straight to STAGE.** `view` is `state.data` = base
*minus* the rows that are only staged for deletion. Writing it to STAGE drops those rows while
`pendingDeletes` still lists them, so a later **Confirm delete** finalises them and `/api/undo`
can no longer bring them back — they vanish silently. `server.js` rebuilds STAGE with
`mergeView(base, view)` instead. Any future save path must do the same.

## Swiggy weeks
`weekPeriods()` is the single source of weeks: recorded payout ranges first (authoritative,
including merged), then the 7-day grid anchored at 1 Sep 2026 (1–5 Sep is the short first block),
then calendar weeks clipped at 31 Aug for anything earlier. Nothing is hardcoded. The offline
weekly chart intentionally still uses plain Sunday→Saturday calendar weeks.

## Menus
The menu is the **source of truth for an item's category** (`resolveCategory`), so moving an item
between groups re-colours its table badges and re-slices the doughnut. A **deleted** item falls back
to the category stored on the order, so history never breaks. `legacy` items keep a `category`.

## Row actions
`actionsCell(collection, id)` renders 🧾 Invoice (works everywhere, it only reads) plus
✏️ Customer and Delete, both `readonly-hide`. Handlers are **delegated on `document`** in
`wireEvents()` and keyed off `data-edit-customer` / `data-del` / `data-invoice`. Renaming a
customer is allowed on `offlineOrders` and `swiggyOrders` only — payouts and investments have
no customer field.

## Gotchas that have already bitten
* `baseOpts(extra)` is a **shallow** `Object.assign` — passing `plugins` replaces the whole default
  plugins object and silently drops the legend styling. Re-declare `legend` when you override it.
* A CSS `display` rule beats the `[hidden]` attribute. Assert visibility with
  `el.getClientRects().length`, never `el.hidden`. (`[hidden]{display:none!important}` is in place.)
  **In a real browser.** In jsdom `getClientRects()` returns 0 even for a plainly visible inline
  element with no layout box — there, assert on `getComputedStyle(el).display` instead. And inline
  `assets/styles.css` yourself, because jsdom will not fetch the `<link>`, so the cascade (and
  therefore `body.is-live .readonly-hide`) is silently untested.
* A `<canvas>` has no DOM children — read chart state via `Chart.getChart(el)`.
* Verify writes against the **files/API**, not just the DOM. See the browser-visual-audit skill,
  pitfalls 16 and 17.

## The write path — `writeAtomic` must never strand a `.tmp`
Every save goes through `writeAtomic(file, text)` in `server.js`: write `<file>.tmp`, then rename
it over the target.

**On Windows `rename` over an existing file needs DELETE access**, so it fails with `EPERM`
whenever anything holds the file open sharing read+write but *not* delete — an editor with the
file in a buffer (**Zed is the one on this machine**), OneDrive, antivirus, the Explorer preview
pane. A plain write only needs WRITE access and is usually still allowed. That asymmetry is the
whole design:

1. write the `.tmp`;
2. `renameSync` up to 6× with backoff, `chmod 0o666` on both files between attempts;
3. **still refused → `writeFileSync(file, text)` in place**, then drop the `.tmp`;
4. only if that also fails, throw naming the file, the code and the likely holders.

Never "simplify" this back to a bare `writeFileSync` + `renameSync`. The old version failed the
save and left the new data orphaned in `babyz-data.js.tmp` — exactly how 7 offline orders were
nearly lost on 27 Sep 2026.

**The read-only attribute is NOT the usual cause** — the real incident showed
`Attributes: Archive`, `IsReadOnly: False`. To name the holder use the Windows Restart Manager
API (`rstrtmgr.dll`: `RmStartSession` → `RmRegisterResources` → `RmGetList`); it returned
`pid=13880 app=Zed`.

A failed write must be **loud**: the client shows it in the modal via `saveFailed(what, res)`,
never a 3.6 s toast.
