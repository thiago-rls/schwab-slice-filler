// Slice Filler — personal Chrome extension for Schwab's trade ticket.
// What it does: calculates dollar amounts per ticker and fills Schwab's order rows.
// What it never does: click Review or Place Order, read balances, or make network requests.
(() => {
  'use strict';
  if (window.__sliceFiller) return;
  window.__sliceFiller = true;

  const KEY = 'sliceFiller.v1';
  const VERSION = '0.5';
  let rootRef = null;
  const MIN_CENTS = 100; // Schwab fractional minimum: $1
  const TICKER_RE = /^[A-Z][A-Z0-9./-]{0,9}$/;

  // ---------- state ----------
  let S = {
    presets: [{ name: 'Monthly', total: '', mode: 'equal', rows: [] }],
    active: 0,
    collapsed: false,
    pos: null
  };
  let run = { busy: false, stop: false, status: '', statusKind: '', waitResolve: null };
  let editingName = false;
  let menuOpen = false;

  const P = () => S.presets[S.active];
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ [KEY]: S }), 250);
  };

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function waitFor(fn, timeout = 5000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (run.stop) return null;
      try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ }
      await sleep(step);
    }
    return null;
  }

  // Query that also looks inside open shadow roots (Schwab uses web components).
  function qa(sel, root = document) {
    const out = [];
    const walk = (r) => {
      r.querySelectorAll(sel).forEach((el) => out.push(el));
      r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot && el.shadowRoot !== rootRef) walk(el.shadowRoot); });
    };
    walk(root);
    return out;
  }
  const q1 = (sel, root = document) => qa(sel, root)[0] || null;
  const q1Of = (root, sel) => q1(sel, root);

  // Set a value the way a user would, so Schwab's framework notices it.
  function setVal(el, v) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function key(el, k) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: k, code: k, bubbles: true, composed: true }));
    }
  }

  // ---------- allocation ----------
  function compute() {
    const p = P();
    const n = p.rows.length;
    const tv = parseFloat(String(p.total).replace(/[,$\s]/g, ''));
    const cents = isFinite(tv) && tv > 0 ? Math.round(tv * 100) : 0;
    let amts = p.rows.map(() => 0);
    let pctSum = 0, pctOk = true;
    if (p.mode === 'equal') {
      if (n) {
        const base = Math.floor(cents / n);
        amts = amts.map(() => base);
        amts[0] += cents - base * n; // leftover cents go to the first ticker
      }
    } else {
      pctSum = Math.round(p.rows.reduce((a, r) => a + (parseFloat(r.p) || 0), 0) * 100) / 100;
      pctOk = Math.abs(pctSum - 100) < 0.001;
      amts = p.rows.map((r) => Math.round(cents * (parseFloat(r.p) || 0) / 100));
      if (pctOk && n) {
        const diff = cents - amts.reduce((a, b) => a + b, 0);
        let li = 0; amts.forEach((a, i) => { if (a > amts[li]) li = i; });
        amts[li] += diff; // rounding difference goes to the largest position
      }
    }
    let error = '';
    if (!n) error = 'Add at least one ticker.';
    else if (!cents) error = 'Enter the total you want to invest.';
    else if (p.mode === 'pct' && !pctOk) error = 'Percentages must add up to 100%.';
    else if (amts.some((a) => a < MIN_CENTS)) error = 'Each ticker needs at least $1.00.';
    return { n, cents, amts, pctSum, pctOk, error };
  }

  // ---------- Schwab page adapters ----------
  // Based on the ticket's markup as of Nov 2026. If Schwab changes it, update here.
  const SEL = {
    orderComponent: 'order-component',
    symbolInput: 'symbol-control:not(#mf-control-symbol) input[role="combobox"]',
    orderControl: 'order-control',
    action: 'select[name="order-action"]',
    unitDollars: 'button[name="unit-Dollars"]',
    amount: 'input[id^="order-control-stepper-quantity-"][id$="-stepper-input"]',
    orderType: 'select[name="order-type"]',
    timing: 'select[name="order-timing-list"]',
    addOrder: 'pf3-sdps-button[aria-label="Add Order"] button',
    estTotal: '#snap_snaptrade_sticky_estimated_amount'
  };
  const VAL = { buy: '49', market: '49', day: '48' };

  function orders() {
    return qa(SEL.orderComponent).filter((c) => {
      const panel = q1('pf3-sdps-panel', c);
      return panel && /^orderPanel-\d+$/.test(panel.id) && visible(panel);
    });
  }
  function orderControlOf(c) {
    const oc = q1(SEL.orderControl, c);
    return oc && !oc.classList.contains('sdps-hide') && visible(oc) ? oc : null;
  }
  function addOrderButton() {
    const list = qa(SEL.addOrder);
    const byText = qa('button').filter((b) => b.textContent.trim() === '+ Add Order');
    return list.concat(byText).find(visible) || null;
  }
  function findSuggestion(input, t) {
    const box = input.closest('pf3-sdps-search') || input.parentElement?.parentElement;
    if (!box) return null;
    const cands = box.querySelectorAll('[role="option"], li, a, button');
    for (const el of cands) {
      if (!visible(el) || el === input) continue;
      const first = el.textContent.trim().split(/\s+/)[0];
      if (first === t) return el;
    }
    return null;
  }
  function askUser(msg) {
    return new Promise((resolve) => {
      run.waitResolve = resolve;
      setStatus(msg, 'wait');
    });
  }

  async function enterSymbol(sym, t) {
    sym.focus();
    setVal(sym, '');
    setVal(sym, t);
    key(sym, t.slice(-1));
    const opt = await waitFor(() => findSuggestion(sym, t), 2500);
    if (opt) opt.click(); else key(sym, 'Enter');
  }

  // An empty ticket has no "Order 1" panel yet: Schwab creates it after a symbol is entered.
  function emptyTicketSymbolBox() {
    return qa(SEL.symbolInput).find(visible)
      || qa('input[placeholder="Enter symbol"]').find((i) => visible(i) && !i.closest('#mf-control-symbol'))
      || null;
  }

  async function fillRow(c, t, cents, idx) {
    const label = `Order ${idx + 1} (${t})`;
    const sym = q1(SEL.symbolInput, c) || q1('input[placeholder="Enter symbol"]', c);
    if (!sym) throw new Error(`${label}: symbol field not found.`);

    const already = (sym.value || '').trim().toUpperCase() === t && orderControlOf(c);
    if (!already) await enterSymbol(sym, t);

    let oc = await waitFor(() => orderControlOf(c), 5000);
    if (!oc && !run.stop) {
      await askUser(`Couldn't confirm ${t} in order ${idx + 1}. Select it in Schwab's ticket, then press Continue.`);
      oc = await waitFor(() => orderControlOf(c), 3000);
    }
    if (run.stop) return;
    if (!oc) throw new Error(`${label}: Schwab didn't accept the symbol.`);

    await sleep(600); // let Schwab finish loading the quote before choosing Buy
    const act = await waitFor(() => { const s = q1Of(oc, SEL.action); return visible(s) && s; }, 3000);
    if (!act) throw new Error(`${label}: Buy/Sell field not found.`);
    if (act.value !== VAL.buy) setVal(act, VAL.buy);
    await sleep(300);

    const dol = await waitFor(() => { const b = q1Of(oc, SEL.unitDollars); return visible(b) && b; }, 3000);
    if (!dol) throw new Error(`${label}: dollar amounts aren't offered for this symbol.`);
    if (!dol.classList.contains('sdps-button--selected')) dol.click();
    await sleep(300);

    const amt = await waitFor(() => { const i = q1Of(oc, SEL.amount); return visible(i) && i; }, 3000);
    if (!amt) throw new Error(`${label}: amount field not found.`);
    amt.focus();
    setVal(amt, (cents / 100).toFixed(2));
    amt.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    amt.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    await sleep(200);

    const ot = q1Of(oc, SEL.orderType);
    if (visible(ot) && ot.value !== VAL.market) setVal(ot, VAL.market);
    const tm = q1Of(oc, SEL.timing);
    if (visible(tm) && tm.value !== VAL.day) setVal(tm, VAL.day);
    await sleep(200);

    if (act.value !== VAL.buy) { setVal(act, VAL.buy); await sleep(300); }

    const got = parseFloat(amt.value);
    if (Math.round(got * 100) !== cents) throw new Error(`${label}: amount shows ${amt.value}, expected ${(cents / 100).toFixed(2)}.`);
  }

  // Second pass: make sure every order still says Buy, then compare Schwab's total with ours.
  function actionOf(c) {
    const oc = q1(SEL.orderControl, c);
    return oc ? q1(SEL.action, oc) : null;
  }
  async function verifyAll(p, cents) {
    setStatus('Checking every order…', 'busy');
    const list = orders();
    for (const c of list) {
      const act = actionOf(c);
      if (act && act.value !== VAL.buy) { setVal(act, VAL.buy); await sleep(400); }
    }
    await sleep(800);
    const missing = orders().map((c, i) => { const a = actionOf(c); return a && a.value === VAL.buy ? null : i + 1; }).filter(Boolean);
    const est = q1(SEL.estTotal);
    const estTxt = est ? est.textContent.trim() : '';
    const estCents = estTxt ? Math.round(Math.abs(parseFloat(estTxt.replace(/[^0-9.\-]/g, ''))) * 100) : NaN;

    if (missing.length) {
      setStatus(`Order ${missing.join(', ')} is missing Buy. Set it in Schwab before you click Review.`, 'err');
    } else if (estTxt && estCents !== cents) {
      setStatus(`Schwab's total is ${estTxt}, but it should be ${fmt(cents)}. Check each order before you click Review.`, 'err');
    } else if (list.length !== p.rows.length) {
      setStatus(`Schwab shows ${list.length} orders, but your list has ${p.rows.length}. Check the ticket.`, 'err');
    } else {
      const note = estTxt ? ` Schwab's total matches (${estTxt}).` : " Couldn't read Schwab's total, so compare it yourself.";
      setStatus(`Filled ${p.rows.length} orders totaling ${fmt(cents)}.${note} Check each row, then click Review in Schwab.`, 'ok');
    }
  }

  async function fillAll() {
    const p = P();
    const { amts, cents, error } = compute();
    if (error || run.busy) return;
    run = { busy: true, stop: false, status: '', statusKind: '', waitResolve: null };
    render();
    try {
      let list = orders();
      if (!list.length) {
        const box = emptyTicketSymbolBox();
        if (!box) {
          const n = qa('input').filter(visible).length;
          throw new Error(`Couldn't find Schwab's symbol box (v${VERSION} saw ${n} visible inputs, ${qa(SEL.orderComponent).length} order sections).`);
        }
        const t0 = p.rows[0].t;
        setStatus(`Starting ticket with ${t0}`, 'busy');
        await enterSymbol(box, t0);
        list = await waitFor(() => (orders().length ? orders() : null), 6000);
        if (!list && !run.stop) {
          await askUser(`Couldn't confirm ${t0}. Select it in Schwab's ticket, then press Continue.`);
          list = await waitFor(() => (orders().length ? orders() : null), 3000);
        }
        if (run.stop) throw new Error('Stopped.');
        if (!list) throw new Error("Order 1 didn't appear after entering the first symbol.");
        if (list.length > 1) throw new Error('The ticket already has orders. Click Clear All in Schwab, then try again.');
      } else {
        const sym0 = (q1(SEL.symbolInput, list[0])?.value || '').trim().toUpperCase();
        const used = list.length > 1 || (sym0 && sym0 !== p.rows[0].t);
        if (used) throw new Error('The ticket already has orders. Click Clear All in Schwab, then try again.');
      }

      for (let i = 0; i < p.rows.length; i++) {
        if (run.stop) break;
        setStatus(`Filling ${i + 1} of ${p.rows.length}: ${p.rows[i].t}`, 'busy');
        while (orders().length < i + 1) {
          const btn = addOrderButton();
          if (!btn) throw new Error(`"+ Add Order" not found after ${i} orders. Schwab may limit orders per ticket.`);
          const before = orders().length;
          btn.click();
          if (!(await waitFor(() => orders().length > before, 4000))) throw new Error('A new order row did not appear.');
          await sleep(300);
        }
        await fillRow(orders()[i], p.rows[i].t, amts[i], i);
      }
      if (run.stop) setStatus('Stopped. Check the ticket before doing anything else.', 'err');
      else await verifyAll(p, cents);
    } catch (e) {
      setStatus(e.message + ' Nothing was submitted.', 'err');
    } finally {
      run.busy = false;
      run.waitResolve = null;
      render();
    }
  }

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = 'slice-filler-host';
  host.style.cssText = 'position:fixed;z-index:2147483646;right:24px;bottom:24px;';
  const root = host.attachShadow({ mode: 'closed' });
  rootRef = root;

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  .w{--bg:#fff;--ink:#141414;--mu:#5e5e5e;--ln:#e7e7e4;--soft:#f2f2f0;--err:#c62828;--ok:#1e7a3e;--acc:#1a4fd6;
     font:14px/1.4 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums;color:var(--ink)}
  @media (prefers-color-scheme:dark){.w{--bg:#1a1a1a;--ink:#f2f2f2;--mu:#a3a3a3;--ln:#2c2c2c;--soft:#242424;--err:#ff8a80;--ok:#7fd49b;--acc:#8fb0ff}}
  button,input{font:inherit;color:inherit}
  button{cursor:pointer}
  button:disabled{opacity:.4;cursor:not-allowed}
  :focus-visible{outline:2px solid var(--acc);outline-offset:1px}
  .pill{height:44px;padding:0 18px;border-radius:22px;border:1px solid var(--ln);background:var(--bg);font-weight:500;display:flex;align-items:center;gap:8px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
  .panel{width:376px;max-height:calc(100vh - 48px);overflow:auto;background:var(--bg);border:1px solid var(--ln);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.14)}
  .hd{display:flex;align-items:center;justify-content:space-between;padding:6px 6px 6px 20px;border-bottom:1px solid var(--ln);cursor:move;user-select:none}
  .hd b{font-size:14px;font-weight:600}
  .hdr{display:flex;align-items:center;gap:2px;position:relative}
  .menu{position:absolute;top:42px;right:0;min-width:190px;padding:6px;background:var(--bg);border:1px solid var(--ln);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);z-index:2;cursor:default}
  .mi{display:flex;align-items:center;gap:10px;width:100%;height:40px;padding:0 10px;border:0;border-radius:7px;background:transparent;font-size:13px;text-align:left}
  .mi:hover{background:var(--soft)}
  .mi svg{color:var(--mu)}
  .ib{width:40px;height:40px;border:0;background:transparent;color:var(--mu);display:flex;align-items:center;justify-content:center;border-radius:8px}
  .bd{padding:16px 20px 18px;display:flex;flex-direction:column;gap:16px}
  .presets{display:flex;gap:6px;flex-wrap:wrap}
  .pr{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--ln);background:transparent;font-size:13px;font-weight:500}
  .pr.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
  .pr.add{color:var(--mu)}
  .nm{height:32px;width:140px;padding:0 10px;border:1px solid var(--acc);border-radius:8px;background:transparent;font-size:13px}
  .lbl{font-size:12px;color:var(--mu);margin-bottom:6px;display:block}
  .tot{display:flex;align-items:center;height:48px;border:1px solid var(--ln);border-radius:10px;padding:0 14px;gap:6px}
  .tot span{font-size:20px;color:var(--mu)}
  .tot input{flex:1;min-width:0;border:0;outline:none;background:transparent;font-size:22px;font-weight:600;letter-spacing:-.02em}
  .seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px;border-radius:10px;background:var(--soft)}
  .seg button{height:36px;border:0;border-radius:7px;background:transparent;color:var(--mu);font-size:13px;font-weight:500}
  .seg button.on{background:var(--bg);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.12)}
  .th,.tr{display:grid;grid-template-columns:1fr 72px 96px 28px;gap:8px;align-items:center}
  .th{padding-bottom:6px;font-size:11px;color:var(--mu);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--ln)}
  .tr{height:44px;border-bottom:1px solid var(--ln)}
  .r{text-align:right}
  .t{font-weight:600}
  .pc{display:flex;justify-content:flex-end;align-items:center;gap:2px;color:var(--mu);font-size:13px}
  .pc input{width:46px;height:30px;text-align:right;border:1px solid var(--ln);border-radius:6px;padding:0 6px;background:transparent;font-size:13px}
  .amt{font-weight:500}
  .amt.bad{color:var(--err)}
  .x{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--mu);display:flex;align-items:center;justify-content:center}
  .rows{max-height:264px;overflow:auto}
  .addr{display:flex;align-items:center;gap:8px;height:44px;border-bottom:1px solid var(--ln)}
  .addr input{flex:1;min-width:0;height:32px;border:0;outline:none;background:transparent;font-weight:500;text-transform:uppercase}
  .addr input::placeholder{text-transform:none;color:var(--mu)}
  .sm{height:28px;padding:0 10px;border:1px solid var(--ln);border-radius:6px;background:transparent;font-size:12px;font-weight:500}
  .sum{display:flex;justify-content:space-between;font-size:13px}
  .sum b{font-weight:600}
  .err{font-size:12px;color:var(--err);margin-top:-8px}
  .go{height:48px;border:0;border-radius:10px;background:var(--ink);color:var(--bg);font-size:14px;font-weight:600}
  .st{font-size:12px;line-height:1.5;text-align:center;margin-top:-6px;color:var(--mu)}
  .st.ok{color:var(--ok)} .st.err{color:var(--err)} .st.wait{color:var(--ink)}
  .ft{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--mu)}
  .lk{border:0;background:transparent;padding:4px 0;font-size:11px;color:var(--mu);text-decoration:underline}
  `;

  const ICON_MIN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';
  const ICON_X = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_MORE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
  const ICON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
  const ICON_UP = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4M7 9l5-5 5 5M5 20h14"/></svg>';
  const ICON_PIE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/></svg>';

  // ---------- export / import ----------
  function exportPresets() {
    const data = { app: 'slice-filler', format: 1, exported: new Date().toISOString(),
      presets: S.presets.map((p) => ({ name: p.name, total: p.total, mode: p.mode, rows: p.rows.map((r) => ({ t: r.t, p: r.p })) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `slice-filler-presets-${new Date().toISOString().slice(0, 10)}.json`;
    root.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    run.status = `Exported ${S.presets.length} preset${S.presets.length === 1 ? '' : 's'}.`; run.statusKind = 'ok';
  }

  function cleanPreset(x) {
    if (!x || typeof x !== 'object') return null;
    const name = String(x.name || '').trim().slice(0, 24);
    if (!name) return null;
    const seen = new Set();
    const rows = (Array.isArray(x.rows) ? x.rows : []).map((r) => ({
      t: String(r && r.t || '').trim().toUpperCase(),
      p: String(r && r.p != null ? r.p : '0').replace(/[^0-9.]/g, '').slice(0, 6) || '0'
    })).filter((r) => TICKER_RE.test(r.t) && !seen.has(r.t) && seen.add(r.t)).slice(0, 50);
    return {
      name,
      total: String(x.total || '').replace(/[^0-9.,]/g, '').slice(0, 12),
      mode: x.mode === 'pct' ? 'pct' : 'equal',
      rows
    };
  }

  function importPresets(file) {
    if (file.size > 200000) { setStatus('That file is too large to be a presets file.', 'err'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { setStatus("That file isn't valid JSON.", 'err'); return; }
      const list = (data && data.app === 'slice-filler' && Array.isArray(data.presets)) ? data.presets.map(cleanPreset).filter(Boolean) : [];
      if (!list.length) { setStatus('No presets found in that file.', 'err'); return; }
      let added = 0, replaced = 0;
      for (const p of list) {
        const i = S.presets.findIndex((x) => x.name.toLowerCase() === p.name.toLowerCase());
        if (i >= 0) { S.presets[i] = p; replaced++; } else { S.presets.push(p); added++; }
      }
      // drop an untouched empty default preset left over from a fresh install
      if (S.presets.length > 1 && !S.presets[0].rows.length && !S.presets[0].total && !list.some((p) => p.name === S.presets[0].name)) S.presets.shift();
      S.active = Math.max(0, S.presets.findIndex((x) => x.name.toLowerCase() === list[0].name.toLowerCase()));
      save();
      const parts = [];
      if (added) parts.push(`added ${added}`);
      if (replaced) parts.push(`replaced ${replaced}`);
      setStatus(`Imported presets: ${parts.join(', ')}.`, 'ok');
    };
    reader.onerror = () => setStatus("Couldn't read that file.", 'err');
    reader.readAsText(file);
  }

  function render() {
    const p = P();
    if (S.collapsed) {
      root.innerHTML = `<style>${CSS}</style><div class="w"><button class="pill" data-a="toggle">${ICON_PIE}Slice filler</button></div>`;
      return;
    }
    const isPct = p.mode === 'pct';
    const presets = S.presets.map((pr, i) =>
      editingName && i === S.active
        ? `<input class="nm" data-a="name" value="${esc(pr.name)}" aria-label="Preset name" maxlength="24">`
        : `<button class="pr ${i === S.active ? 'on' : ''}" data-a="preset" data-i="${i}">${esc(pr.name)}</button>`
    ).join('');
    const rows = p.rows.map((r, i) => `
      <div class="tr">
        <div class="t">${esc(r.t)}</div>
        ${isPct
          ? `<div class="pc"><input data-a="pct" data-i="${i}" inputmode="decimal" value="${esc(r.p)}" aria-label="Percent for ${esc(r.t)}">%</div>`
          : `<div class="r pc" data-eq></div>`}
        <div class="r amt" data-amt="${i}"></div>
        <button class="x" data-a="rm" data-i="${i}" aria-label="Remove ${esc(r.t)}">${ICON_X}</button>
      </div>`).join('');
    root.innerHTML = `<style>${CSS}</style>
    <div class="w"><div class="panel" role="region" aria-label="Slice filler">
      <div class="hd" data-drag><b>Slice filler <span style="font-weight:400;color:var(--mu);font-size:11px">v${VERSION}</span></b><div class="hdr">
          <button class="ib" data-a="menu" aria-label="Presets menu" aria-haspopup="menu" aria-expanded="${menuOpen}">${ICON_MORE}</button>
          <button class="ib" data-a="toggle" aria-label="Collapse panel">${ICON_MIN}</button>
          ${menuOpen ? `<div class="menu" role="menu">
            <button class="mi" role="menuitem" data-a="export">${ICON_DOWN}Export presets</button>
            <button class="mi" role="menuitem" data-a="import">${ICON_UP}Import presets</button>
          </div>` : ''}
        </div>
        <input type="file" accept=".json,application/json" data-a="file" hidden></div>
      <div class="bd">
        <div class="presets">${presets}<button class="pr add" data-a="newpreset" aria-label="New preset">+</button></div>
        <div><label class="lbl" for="tot">Total to invest</label>
          <div class="tot"><span>$</span><input id="tot" data-a="total" inputmode="decimal" value="${esc(p.total)}" placeholder="0.00"></div></div>
        <div class="seg" role="group" aria-label="Allocation mode">
          <button class="${isPct ? '' : 'on'}" data-a="mode" data-m="equal" aria-pressed="${!isPct}">Equal split</button>
          <button class="${isPct ? 'on' : ''}" data-a="mode" data-m="pct" aria-pressed="${isPct}">By percent</button>
        </div>
        <div>
          <div class="th"><div>Ticker</div><div class="r">%</div><div class="r">Amount</div><div></div></div>
          <div class="rows">${rows}</div>
          <div class="addr"><input data-a="newt" placeholder="+ Add ticker" aria-label="Add ticker" maxlength="10"><button class="sm" data-a="addt">Add</button></div>
        </div>
        <div class="sum"><span data-sum></span><b data-total></b></div>
        <div class="err" role="alert" data-err></div>
        ${run.busy
          ? `<button class="go" data-a="stop">Stop</button>`
          : `<button class="go" data-a="fill">Fill order</button>`}
        ${run.waitResolve ? `<button class="sm" data-a="continue">Continue</button>` : ''}
        <div class="st ${run.statusKind}" role="status" data-st>${esc(run.status)}</div>
        <div class="ft"><span>Fills the ticket only. You review and submit.</span>
          <span><button class="lk" data-a="rename">Rename</button>${S.presets.length > 1 ? ` · <button class="lk" data-a="delpreset">Delete</button>` : ''}</span></div>
      </div>
    </div></div>`;
    updateComputed();
    if (editingName) { const n = root.querySelector('[data-a="name"]'); n.focus(); n.select(); }
  }

  // Updates numbers without re-rendering, so typing keeps focus.
  function updateComputed() {
    if (S.collapsed) return;
    const p = P();
    const c = compute();
    root.querySelectorAll('[data-amt]').forEach((el) => {
      const i = +el.dataset.amt;
      el.textContent = fmt(c.amts[i] || 0);
      el.classList.toggle('bad', !!c.cents && (c.amts[i] || 0) < MIN_CENTS);
    });
    const eq = c.n ? (Math.round(10000 / c.n) / 100) + '%' : '';
    root.querySelectorAll('[data-eq]').forEach((el) => { el.textContent = eq; });
    const sum = root.querySelector('[data-sum]');
    if (p.mode === 'pct') {
      sum.textContent = c.pctOk ? 'Allocated 100%' : `Allocated ${c.pctSum}% of 100%`;
      sum.style.color = c.pctOk ? 'var(--ok)' : 'var(--err)';
    } else {
      sum.textContent = c.n ? `${c.n} tickers, equal split` : 'No tickers';
      sum.style.color = 'var(--mu)';
    }
    root.querySelector('[data-total]').textContent = fmt(c.cents);
    root.querySelector('[data-err]').textContent = c.error;
    const go = root.querySelector('[data-a="fill"]');
    if (go) go.disabled = !!c.error;
  }

  function setStatus(msg, kind) {
    run.status = msg; run.statusKind = kind;
    render();
  }

  function addTicker() {
    const inp = root.querySelector('[data-a="newt"]');
    const t = (inp.value || '').trim().toUpperCase();
    if (!t) return;
    if (!TICKER_RE.test(t)) { setStatus(`"${t}" doesn't look like a ticker.`, 'err'); return; }
    if (P().rows.some((r) => r.t === t)) { setStatus(`${t} is already in the list.`, 'err'); return; }
    P().rows.push({ t, p: '0' });
    run.status = '';
    save(); render();
    root.querySelector('[data-a="newt"]').focus();
  }

  // ---------- events ----------
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) { if (menuOpen && !e.target.closest('.menu')) { menuOpen = false; render(); } return; }
    const a = b.dataset.a;
    if (run.busy && !['stop', 'continue', 'toggle'].includes(a)) return;
    if (a !== 'menu' && menuOpen) { menuOpen = false; if (!['export', 'import'].includes(a)) render(); }
    if (a === 'menu') { menuOpen = !menuOpen; render(); }
    else if (a === 'export') { exportPresets(); render(); }
    else if (a === 'import') { render(); root.querySelector('[data-a="file"]').click(); }
    else if (a === 'toggle') { S.collapsed = !S.collapsed; save(); render(); }
    else if (a === 'preset') { S.active = +b.dataset.i; editingName = false; run.status = ''; save(); render(); }
    else if (a === 'newpreset') {
      S.presets.push({ name: `Preset ${S.presets.length + 1}`, total: '', mode: 'equal', rows: [] });
      S.active = S.presets.length - 1; editingName = true; save(); render();
    }
    else if (a === 'rename') { editingName = true; render(); }
    else if (a === 'delpreset') {
      if (S.presets.length > 1) { S.presets.splice(S.active, 1); S.active = 0; save(); render(); }
    }
    else if (a === 'mode') { P().mode = b.dataset.m; save(); render(); }
    else if (a === 'rm') { P().rows.splice(+b.dataset.i, 1); save(); render(); }
    else if (a === 'addt') addTicker();
    else if (a === 'fill') fillAll();
    else if (a === 'stop') { run.stop = true; if (run.waitResolve) { run.waitResolve(); run.waitResolve = null; } }
    else if (a === 'continue') { const r = run.waitResolve; run.waitResolve = null; render(); if (r) r(); }
  });

  root.addEventListener('change', (e) => {
    if (e.target.dataset?.a !== 'file') return;
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importPresets(f);
  });

  root.addEventListener('input', (e) => {
    const el = e.target;
    const a = el.dataset?.a;
    if (a === 'total') { el.value = el.value.replace(/[^0-9.,]/g, ''); P().total = el.value; save(); updateComputed(); }
    else if (a === 'pct') { el.value = el.value.replace(/[^0-9.]/g, ''); P().rows[+el.dataset.i].p = el.value; save(); updateComputed(); }
  });

  root.addEventListener('keydown', (e) => {
    const a = e.target.dataset?.a;
    if (a === 'newt' && e.key === 'Enter') { e.preventDefault(); addTicker(); }
    if (a === 'name' && (e.key === 'Enter' || e.key === 'Escape')) { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape' && menuOpen) { menuOpen = false; render(); root.querySelector('[data-a="menu"]')?.focus(); }
    e.stopPropagation(); // keep Schwab's shortcuts from reacting to typing in the panel
  });

  root.addEventListener('focusout', (e) => {
    if (e.target.dataset?.a === 'name') {
      const v = e.target.value.trim();
      if (v) P().name = v.slice(0, 24);
      editingName = false; save(); render();
    }
  });

  // Drag by the header.
  root.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-drag]') || e.target.closest('button, .menu')) return;
    const r = host.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      const x = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
      const y = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy));
      Object.assign(host.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
      S.pos = { x, y };
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); save(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ---------- start ----------
  chrome.storage.local.get(KEY, (res) => {
    if (res && res[KEY] && Array.isArray(res[KEY].presets) && res[KEY].presets.length) {
      S = Object.assign(S, res[KEY]);
      if (S.active >= S.presets.length) S.active = 0;
    }
    if (S.pos) {
      const x = Math.min(S.pos.x, window.innerWidth - 100), y = Math.min(S.pos.y, window.innerHeight - 60);
      Object.assign(host.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    }
    document.documentElement.appendChild(host);
    render();
  });
})();
