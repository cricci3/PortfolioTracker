/* Investment Tracker — dashboard logic. Vanilla JS, no external dependencies. */
(() => {
  "use strict";

  const TOKEN = document.querySelector('meta[name="tracker-token"]').content;
  const LOCALE = "en-GB";
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const state = {
    data: null,
    loadedAt: null,
    range: 0,
    sort: store("it-sort") || "value",
    capitalFor: null,
    editFor: null,
    detailId: null,
    picked: null,
  };

  // ------------------------------------------------------------ utilities ----
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { "X-Tracker-Token": TOKEN, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty response */ }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cur = () => (state.data && state.data.base_currency) || "EUR";
  const fmtCache = {};
  function money(v, dec) {
    if (v == null || isNaN(v)) return "—";
    if (dec == null) dec = Math.abs(v) >= 10000 ? 0 : 2;
    const k = cur() + dec;
    fmtCache[k] = fmtCache[k] || new Intl.NumberFormat(LOCALE, { style: "currency", currency: cur(), minimumFractionDigits: dec, maximumFractionDigits: dec });
    return fmtCache[k].format(v);
  }
  const signedMoney = (v, dec) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), dec));
  const pct = (v, dec = 1) => (v == null || isNaN(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString(LOCALE, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + "%");
  const num = (v, dec = 4) => (v == null ? "—" : v.toLocaleString(LOCALE, { maximumFractionDigits: dec }));
  const tone = (v) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  const dateFmt = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
  const monthFmt = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(LOCALE, { month: "short", year: "2-digit" });
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  // accepts "1000", "1,000.50", "1.000,50", "1000,5"
  function parseNum(s) {
    s = String(s ?? "").trim().replace(/[\s€$£]/g, "");
    if (s === "") return null;
    const lastComma = s.lastIndexOf(","), lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const n = Number(s);
    return isNaN(n) ? NaN : n;
  }
  const plainNum = (v) => (v == null ? "" : String(Math.round(v * 1e6) / 1e6));
  const held = (days) => days >= 365 ? `${(days / 365).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} years` : `${Math.max(days, 0)} days`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 5000 : 2600);
  }

  const ICON = {
    plus: `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`,
    edit: `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>`,
    trash: `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  };

  // --------------------------------------------------------------- charts ----
  let gradSeq = 0;

  function sliceRange(series, days) {
    if (!series || !days) return series;
    const last = new Date(series.dates[series.dates.length - 1]);
    const from = new Date(last.getTime() - days * 864e5).toISOString().slice(0, 10);
    let i = series.dates.findIndex((d) => d >= from);
    if (i < 0) i = 0;
    if (series.dates.length - i < 2) i = Math.max(0, series.dates.length - 2);
    return { dates: series.dates.slice(i), value: series.value.slice(i), invested: series.invested.slice(i) };
  }

  function niceTicks(min, max, count = 4) {
    const span = max - min || Math.abs(max) || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  const compact = (v) => new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 }).format(v);

  /**
   * Draws an SVG chart of the value (line + area), with invested capital as a dashed step line.
   * opts: { axes, interactive, color }
   */
  function drawChart(el, series, opts = {}) {
    el.innerHTML = "";
    if (!series || series.dates.length < 2) {
      el.innerHTML = `<div class="hint" style="padding:20px 0">Not enough data for a chart yet.</div>`;
      return;
    }
    const W = Math.max(el.clientWidth, 120), H = Math.max(el.clientHeight, 40);
    const pad = opts.axes ? { l: 52, r: 8, t: 10, b: 24 } : { l: 1, r: 1, t: 4, b: 2 };
    const n = series.dates.length;
    const vals = series.value.concat(opts.axes ? series.invested : []);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    const padY = (hi - lo) * (opts.axes ? 0.08 : 0.12);
    lo -= padY; hi += padY;
    if (opts.axes && lo < 0 && Math.min(...vals) >= 0) lo = 0;
    const x = (i) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    const color = opts.color || "var(--chart-value)";
    const gid = "g" + ++gradSeq;

    const line = series.value.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const area = `${line}L${x(n - 1).toFixed(1)},${H - pad.b}L${x(0).toFixed(1)},${H - pad.b}Z`;
    // invested capital as steps
    let inv = "";
    series.invested.forEach((v, i) => {
      inv += i ? `H${x(i).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(0).toFixed(1)},${y(v).toFixed(1)}`;
    });

    let axes = "";
    if (opts.axes) {
      for (const t of niceTicks(lo, hi, 4)) {
        if (t < lo || t > hi) continue;
        axes += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`;
        axes += `<text class="axis-text" x="${pad.l - 8}" y="${y(t) + 4}" text-anchor="end">${compact(t)}</text>`;
      }
      const labels = Math.min(6, Math.max(2, Math.floor((W - pad.l) / 110)));
      for (let k = 0; k < labels; k++) {
        const i = Math.round((k / (labels - 1)) * (n - 1));
        const anchor = k === 0 ? "start" : k === labels - 1 ? "end" : "middle";
        axes += `<text class="axis-text" x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${monthFmt(series.dates[i])}</text>`;
      }
    }

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Value over time">
        <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style="stop-color:${color};stop-opacity:.22"/>
          <stop offset="1" style="stop-color:${color};stop-opacity:0"/>
        </linearGradient></defs>
        ${axes}
        <path d="${area}" fill="url(#${gid})"/>
        ${opts.axes ? `<path class="line-invested" d="${inv}"/>` : ""}
        <path class="line-value" d="${line}" style="stroke:${color}"/>
        ${opts.interactive ? `<g class="hover" style="display:none"><line class="cursor" y1="${pad.t}" y2="${H - pad.b}"/><circle class="cursor-dot" r="4" style="stroke:${color}"/></g>
        <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent"/>` : ""}
      </svg>`;

    if (!opts.interactive) return;
    const svg = el.querySelector("svg"), g = svg.querySelector(".hover");
    const tip = document.createElement("div");
    tip.className = "tip"; tip.style.display = "none";
    el.appendChild(tip);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
      const cx = x(i), v = series.value[i], iv = series.invested[i];
      g.style.display = "";
      g.querySelector("line").setAttribute("x1", cx); g.querySelector("line").setAttribute("x2", cx);
      g.querySelector("circle").setAttribute("cx", cx); g.querySelector("circle").setAttribute("cy", y(v));
      const gain = v - iv;
      tip.innerHTML = `<div class="d">${dateFmt(series.dates[i])}</div>
        <div class="r"><span>Value</span><span>${money(v)}</span></div>
        <div class="r"><span>Invested</span><span>${money(iv)}</span></div>
        <div class="r"><span>Result</span><span class="${tone(gain)}">${signedMoney(gain)} · ${pct(iv ? (gain / iv) * 100 : 0)}</span></div>`;
      tip.style.display = "block";
      const left = (cx / W) * r.width;
      tip.style.left = Math.min(Math.max(left + 14, 0), r.width - tip.offsetWidth) + "px";
      if (left + 14 + tip.offsetWidth > r.width) tip.style.left = Math.max(left - tip.offsetWidth - 14, 0) + "px";
    };
    const leave = () => { g.style.display = "none"; tip.style.display = "none"; };
    svg.addEventListener("mousemove", move);
    svg.addEventListener("touchmove", move, { passive: true });
    svg.addEventListener("mouseleave", leave);
    svg.addEventListener("touchend", leave);
  }

  // --------------------------------------------------------------- render ----
  function renderKpis() {
    const s = state.data.summary;
    const el = $("#kpis");
    if (!s.asset_count) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
      <div class="kpi"><div class="label">Invested capital</div><div class="v num">${money(s.invested)}</div><div class="s">${plural(s.asset_count, "asset")}</div></div>
      <div class="kpi"><div class="label">Current value</div><div class="v num ${tone(s.gain)}">${money(s.value)}</div><div class="s">${s.error_count ? `<span class="neg">${plural(s.error_count, "asset")} without data</span>` : "at closing prices"}</div></div>
      <div class="kpi"><div class="label">Gain</div><div class="v num ${tone(s.gain)}">${signedMoney(s.gain)}</div><div class="s"><b class="${tone(s.gain)}">${pct(s.return_pct, 2)}</b> on invested</div></div>
      <div class="kpi"><div class="label">Annual return</div><div class="v num ${tone(s.annualized_pct)}">${pct(s.annualized_pct)}</div><div class="s">money-weighted (XIRR)</div></div>
      <div class="kpi"><div class="label">Last 12 months</div><div class="v num ${tone(s.yoy_pct)}">${pct(s.yoy_pct)}</div><div class="s">${s.yoy_gain == null ? "needs 1 year of history" : `<b class="${tone(s.yoy_gain)}">${signedMoney(s.yoy_gain)}</b> YoY`}</div></div>`;
  }

  function renderOverview() {
    const d = state.data;
    const box = $("#overview");
    if (!d.series || d.series.dates.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    $$("#range button").forEach((b) => b.classList.toggle("on", Number(b.dataset.range) === state.range));
    drawChart($("#main-chart"), sliceRange(d.series, state.range), { axes: true, interactive: true });

    const ok = d.assets.filter((a) => !a.error && a.value > 0).sort((a, b) => b.value - a.value);
    const total = ok.reduce((s, a) => s + a.value, 0);
    if (ok.length < 2) { $("#alloc").hidden = true; return; }
    $("#alloc").hidden = false;
    const colors = ["--a1", "--a2", "--a3", "--a4", "--a5", "--a6"];
    const col = (i) => `var(${colors[i % colors.length]})`;
    $("#alloc").innerHTML = `
      <div class="alloc-bar">${ok.map((a, i) => `<i style="width:${(a.value / total) * 100}%;background:${col(i)}" title="${esc(a.ticker)}"></i>`).join("")}</div>
      <div class="alloc-legend">${ok.map((a, i) => `<span><i style="background:${col(i)}"></i>${esc(shortName(a))} <b>${((a.value / total) * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1 })}%</b></span>`).join("")}</div>`;
  }

  const shortName = (a) => (a.name && a.name !== a.ticker ? a.name.replace(/\s+(UCITS ETF|ETF|Inc\.?|S\.p\.A\.?|plc|N\.V\.|AG|SE)\b.*$/i, "") : a.ticker);

  function sortedAssets() {
    const list = [...state.data.assets];
    const key = {
      value: (a) => -(a.value || 0),
      return: (a) => -(a.return_pct ?? -1e9),
      yoy: (a) => -(a.yoy?.pct ?? -1e9),
      name: (a) => shortName(a).toLowerCase(),
    }[state.sort];
    return list.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  function assetCard(a) {
    const letter = esc((shortName(a)[0] || "?").toUpperCase());
    const meta = [a.ticker, a.exchange, a.first_date ? "since " + dateFmt(a.first_date) : ""].filter(Boolean).map(esc).join(" · ");
    const editBtn = `<button class="btn btn-sm btn-ghost" data-act="edit" title="Edit asset">${ICON.edit}Edit</button>`;
    if (a.error) {
      return `<article class="card asset is-error" data-id="${a.id}">
        <div class="asset-top"><div class="mono">${letter}</div><div class="asset-name"><div class="n">${esc(shortName(a))}</div><div class="m">${meta}</div></div></div>
        <div class="err">${esc(a.error)}</div>
        <div class="asset-actions">${editBtn}<button class="btn btn-sm btn-ghost" data-act="detail">Details</button></div>
      </article>`;
    }
    const n = a.contributions.length;
    const yoy = a.yoy;
    return `<article class="card asset ${a.gain < 0 ? "is-neg" : ""}" data-id="${a.id}">
      <div class="asset-top">
        <div class="mono">${letter}</div>
        <div class="asset-name"><div class="n" title="${esc(a.name)}">${esc(shortName(a))}</div><div class="m">${meta}</div></div>
        <span class="chip ${tone(a.day_change_pct)}" title="Change in the last session">${pct(a.day_change_pct, 2)} today</span>
      </div>
      <div class="asset-mid">
        <div>
          <div class="label">Value</div>
          <div class="v num">${money(a.value)}</div>
          <div class="d ${tone(a.gain)}">${pct(a.return_pct, 2)} · ${signedMoney(a.gain)}</div>
        </div>
        <div class="spark" data-spark="${a.id}"></div>
      </div>
      <div class="asset-stats">
        <div><div class="label">Invested</div><div class="v">${money(a.invested)}</div><div class="s">${plural(n, "contribution")}</div></div>
        <div><div class="label">Annual</div><div class="v ${tone(a.annualized_pct)}">${pct(a.annualized_pct)}</div><div class="s">${a.annualized_pct == null ? "after 6 months" : "XIRR"}</div></div>
        <div><div class="label">12 months</div><div class="v ${tone(yoy?.pct)}">${yoy ? pct(yoy.pct) : "—"}</div><div class="s ${yoy ? tone(yoy.gain) : ""}">${yoy ? signedMoney(yoy.gain, 0) : held(a.held_days) + " of history"}</div></div>
      </div>
      <div class="asset-actions">
        <button class="btn btn-sm" data-act="capital">${ICON.plus}Add capital</button>
        ${editBtn}
        <button class="btn btn-sm btn-ghost" data-act="detail">Details</button>
      </div>
    </article>`;
  }

  function renderGrid() {
    const d = state.data;
    $("#eyebrow").textContent = `Portfolio · ${plural(d.assets.length, "asset")}`;
    $("#demo-banner").hidden = !d.demo;
    $("#assets-head").hidden = !d.assets.length;
    $("#sort").value = state.sort;
    if (!d.assets.length) {
      $("#grid").innerHTML = `<div class="empty">
        <h3>No assets yet</h3>
        <p>Add your first investment: search for its ticker or ISIN, then enter the start date and the amount. Later contributions (e.g. a monthly savings plan) are added from the asset's card.</p>
        <button class="btn btn-primary" data-act="add">${ICON.plus}Add asset</button>
      </div>`;
      return;
    }
    $("#grid").innerHTML = sortedAssets().map(assetCard).join("");
    drawSparks();
  }

  function drawSparks() {
    if (!state.data) return;
    for (const el of $$("[data-spark]")) {
      const a = state.data.assets.find((x) => x.id === el.dataset.spark);
      if (a && a.series) drawChart(el, a.series, { color: a.gain >= 0 ? "var(--pos)" : "var(--neg)" });
    }
  }

  function renderAll() {
    renderKpis();
    renderOverview();
    renderGrid();
    updateSync();
    if ($("#dlg-detail").open && state.detailId) renderDetail(state.detailId);
  }

  function updateSync(status) {
    const el = $("#sync"), txt = $("#sync-text");
    el.classList.remove("loading", "error");
    if (status === "loading") { el.classList.add("loading"); txt.textContent = "Updating prices…"; return; }
    if (status === "error") { el.classList.add("error"); txt.textContent = "Update failed"; return; }
    if (!state.loadedAt || !state.data) return;
    const last = state.data.assets.map((a) => a.last_date).filter(Boolean).sort().pop();
    const mins = Math.round((Date.now() - state.loadedAt) / 60000);
    txt.textContent = (last ? `Prices as of ${dateFmt(last)} · ` : "") + (mins < 1 ? "updated just now" : `updated ${mins} min ago`);
  }

  // ---------------------------------------------------------------- loading ----
  async function load(refresh = false) {
    updateSync("loading");
    $("#btn-refresh").classList.add("spinning");
    if (!state.data) $("#grid").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
    try {
      state.data = await api("GET", "/api/portfolio" + (refresh ? "?refresh=1" : ""));
      state.loadedAt = Date.now();
      renderAll();
      if (refresh) toast("Prices updated");
    } catch (e) {
      updateSync("error");
      toast(e.message, true);
      if (!state.data) $("#grid").innerHTML = `<div class="empty"><h3>Couldn't load the portfolio</h3><p>${esc(e.message)}</p></div>`;
    } finally {
      $("#btn-refresh").classList.remove("spinning");
    }
  }

  const findAsset = (id) => state.data && state.data.assets.find((x) => x.id === id);

  // -------------------------------------------------------------- add asset ----
  const dlgAdd = $("#dlg-add");
  let searchTimer, searchSeq = 0;
  const RAW_TICKER_LABEL = "Use this ticker as typed";

  function openAdd() {
    state.picked = null;
    $("#form-add").reset();
    $("#step-search").hidden = false;
    $("#step-details").hidden = true;
    $("#results").innerHTML = "";
    $("#add-error").hidden = true;
    $("#add-date").value = todayISO();
    $("#add-date").max = todayISO();
    dlgAdd.showModal();
    $("#q").focus();
  }

  async function runSearch() {
    const q = $("#q").value.trim();
    const seq = ++searchSeq;
    if (q.length < 2) { $("#results").innerHTML = ""; return; }
    $("#results").innerHTML = `<li class="msg">Searching…</li>`;
    try {
      const r = await api("GET", "/api/search?q=" + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      const items = r.results.slice(0, 10);
      // a ticker typed exactly but missing from the results can still be used as-is
      if (!r.is_isin && /^[A-Za-z0-9.\-=^]{1,20}$/.test(q) && !items.some((x) => x.symbol.toUpperCase() === q.toUpperCase())) {
        items.push({ symbol: q.toUpperCase(), name: RAW_TICKER_LABEL, exchange: "" });
      }
      $("#results").innerHTML = items.length
        ? items.map((x, i) => `<li><button type="button" data-i="${i}"><span class="sym">${esc(x.symbol)}</span><span class="nm">${esc(x.name)}</span><span class="ex">${esc(x.exchange)}</span></button></li>`).join("")
        : `<li class="msg">No results. Try the Yahoo ticker (e.g. VWCE.DE).</li>`;
      $$("#results button").forEach((b) => b.addEventListener("click", () => pick(items[Number(b.dataset.i)])));
    } catch (e) {
      if (seq === searchSeq) $("#results").innerHTML = `<li class="msg">${esc(e.message)}</li>`;
    }
  }

  function pick(item) {
    state.picked = { ...item, input_symbol: $("#q").value.trim() };
    $("#picked").innerHTML = `<div class="mono">${esc((item.name || item.symbol)[0].toUpperCase())}</div><div><div class="sym">${esc(item.symbol)}</div><div class="nm">${esc(item.name)}${item.exchange ? " · " + esc(item.exchange) : ""}</div></div>`;
    $("#step-search").hidden = true;
    $("#step-details").hidden = false;
    $("#add-amount").focus();
  }

  async function submitAdd(ev) {
    ev.preventDefault();
    if (!state.picked) return;
    const err = $("#add-error");
    err.hidden = true;
    const amount = parseNum($("#add-amount").value), price = parseNum($("#add-price").value);
    if (!amount || amount <= 0) { err.textContent = "Enter a valid amount."; err.hidden = false; return; }
    if (Number.isNaN(price)) { err.textContent = "The unit price is not a valid number."; err.hidden = false; return; }
    const btn = $("#add-save");
    btn.disabled = true; btn.textContent = "Checking on Yahoo…";
    try {
      const r = await api("POST", "/api/assets", {
        ticker: state.picked.symbol,
        name: state.picked.name === RAW_TICKER_LABEL ? "" : state.picked.name,
        exchange: state.picked.exchange,
        input_symbol: state.picked.input_symbol,
        date: $("#add-date").value,
        amount, price,
      });
      dlgAdd.close();
      toast(r.merged ? "Asset already in portfolio: added as a new contribution" : "Asset added");
      await load();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Add to portfolio";
    }
  }

  // ------------------------------------------------------------ add capital ----
  const dlgCap = $("#dlg-capital");

  function openCapital(id) {
    const a = findAsset(id);
    if (!a) return;
    state.capitalFor = id;
    $("#form-capital").reset();
    $("#cap-error").hidden = true;
    $("#cap-asset").textContent = `${shortName(a)} · ${a.ticker}`;
    $("#cap-date").value = todayISO();
    $("#cap-date").max = todayISO();
    const last = a.contributions.length ? a.contributions[a.contributions.length - 1].amount : null;
    const amounts = [...new Set([last, 100, 250, 500].filter(Boolean))].slice(0, 4);
    $("#cap-quick").innerHTML = amounts.map((v, i) => `<button type="button" class="btn btn-sm" data-v="${v}">${i === 0 && v === last ? "Same as last · " : ""}${money(v, 0)}</button>`).join("");
    $$("#cap-quick button").forEach((b) => b.addEventListener("click", () => { $("#cap-amount").value = b.dataset.v; }));
    dlgCap.showModal();
    $("#cap-amount").focus();
  }

  async function submitCapital(ev) {
    ev.preventDefault();
    const err = $("#cap-error");
    err.hidden = true;
    const amount = parseNum($("#cap-amount").value), price = parseNum($("#cap-price").value);
    if (!amount || amount <= 0) { err.textContent = "Enter a valid amount."; err.hidden = false; return; }
    if (Number.isNaN(price)) { err.textContent = "The unit price is not a valid number."; err.hidden = false; return; }
    try {
      await api("POST", `/api/assets/${state.capitalFor}/contributions`, {
        date: $("#cap-date").value,
        amount, price,
        note: $("#cap-note").value.trim(),
      });
      dlgCap.close();
      toast(`Contribution of ${money(amount)} saved`);
      await load();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
  }

  // ------------------------------------------------------------- edit asset ----
  const dlgEdit = $("#dlg-edit");

  function editRow(c = {}) {
    const row = document.createElement("div");
    row.className = "edit-row";
    if (c.id) row.dataset.id = c.id;
    row.innerHTML = `
      <label class="c-date"><span class="edit-mobile-label">Date</span><input type="date" name="date" max="${todayISO()}" value="${esc(c.date || todayISO())}" required></label>
      <label class="c-amount"><span class="edit-mobile-label">Amount (€)</span><input type="text" name="amount" inputmode="decimal" value="${esc(plainNum(c.amount))}" placeholder="0.00" required></label>
      <label class="c-price"><span class="edit-mobile-label">Unit price</span><input type="text" name="price" inputmode="decimal" value="${esc(plainNum(c.price_input))}" placeholder="close"></label>
      <label class="c-note"><span class="edit-mobile-label">Note</span><input type="text" name="note" maxlength="200" value="${esc(c.note || "")}" placeholder="—"></label>
      <button type="button" class="row-del" title="Remove this contribution" aria-label="Remove contribution">${ICON.trash}</button>`;
    row.querySelector(".row-del").addEventListener("click", () => {
      if ($$(".edit-row:not(.head)", $("#edit-rows")).length <= 1) {
        showEditError("An asset needs at least one contribution. To remove it completely use “Delete asset”.");
        return;
      }
      row.remove();
    });
    return row;
  }

  function showEditError(msg) {
    const err = $("#edit-error");
    err.textContent = msg; err.hidden = !msg;
  }

  function openEdit(id, focusContributionId) {
    const a = findAsset(id);
    if (!a) return;
    state.editFor = id;
    showEditError("");
    $("#edit-name").value = a.name || "";
    $("#edit-ticker").value = a.ticker;
    $("#edit-ticker-hint").hidden = true;
    const rows = $("#edit-rows");
    rows.innerHTML = `<div class="edit-row head"><span>Date</span><span>Amount (€)</span><span>Unit price <span style="text-transform:none;letter-spacing:0">(optional)</span></span><span>Note</span><span></span></div>`;
    // rows come sorted by date and carry the price/note exactly as entered
    for (const c of a.contributions) rows.appendChild(editRow(c));
    const del = $("#edit-delete");
    del.classList.remove("armed"); del.textContent = "Delete asset";
    dlgEdit.showModal();
    const target = focusContributionId && rows.querySelector(`[data-id="${focusContributionId}"]`);
    if (target) {
      target.classList.add("flash");
      target.scrollIntoView({ block: "nearest" });
      target.querySelector('input[name="amount"]').focus();
    } else {
      rows.scrollTop = rows.scrollHeight; // show the most recent contributions first
      $("#edit-name").focus();
    }
  }

  async function submitEdit(ev) {
    ev.preventDefault();
    showEditError("");
    const contributions = [];
    let bad = false;
    for (const row of $$(".edit-row:not(.head)", $("#edit-rows"))) {
      const f = (n) => row.querySelector(`[name="${n}"]`);
      [f("date"), f("amount"), f("price")].forEach((i) => i.classList.remove("invalid"));
      const amount = parseNum(f("amount").value), price = parseNum(f("price").value);
      if (!f("date").value || f("date").value > todayISO()) { f("date").classList.add("invalid"); bad = true; }
      if (!amount || amount <= 0) { f("amount").classList.add("invalid"); bad = true; }
      if (Number.isNaN(price) || (price != null && price <= 0)) { f("price").classList.add("invalid"); bad = true; }
      contributions.push({ id: row.dataset.id || null, date: f("date").value, amount, price, note: f("note").value.trim() });
    }
    if (bad) { showEditError("Check the highlighted fields: dates can't be in the future and amounts must be positive numbers."); return; }
    if (!contributions.length) { showEditError("An asset needs at least one contribution."); return; }
    const ticker = $("#edit-ticker").value.trim().toUpperCase();
    if (!ticker) { showEditError("The ticker can't be empty."); return; }
    const btn = $("#edit-save");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api("PUT", `/api/assets/${state.editFor}`, { name: $("#edit-name").value.trim(), ticker, contributions });
      dlgEdit.close();
      toast("Changes saved");
      await load();
    } catch (e) {
      showEditError(e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Save changes";
    }
  }

  async function deleteAsset(btn, id, after) {
    if (!btn.classList.contains("armed")) {
      btn.classList.add("armed"); btn.textContent = "Click again to delete";
      setTimeout(() => { btn.classList.remove("armed"); btn.textContent = "Delete asset"; }, 4000);
      return;
    }
    try {
      await api("DELETE", `/api/assets/${id}`);
      after();
      toast("Asset deleted");
      await load();
    } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- details ----
  const dlgDetail = $("#dlg-detail");

  function openDetail(id) {
    state.detailId = id;
    renderDetail(id);
    if (!dlgDetail.open) dlgDetail.showModal();
  }

  function renderDetail(id) {
    const a = findAsset(id);
    const box = $("#detail");
    if (!a) { dlgDetail.close(); return; }
    const rows = [...(a.contributions || [])].reverse().map((c) => {
      const pl = c.value_now - c.amount;
      return `<tr>
        <td>${dateFmt(c.date)}${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</td>
        <td>${money(c.amount)}</td>
        <td title="Executed on ${dateFmt(c.exec_date)}${c.price_input ? " (price entered)" : " (closing price)"}">${money(c.exec_price, 2)}${c.price_input ? " ✓" : ""}</td>
        <td>${num(c.shares)}</td>
        <td>${money(c.value_now)}</td>
        <td class="${tone(pl)}">${pct((pl / c.amount) * 100)}</td>
        <td><button class="del" data-edit-c="${c.id}" title="Edit this contribution" aria-label="Edit contribution">${ICON.edit}</button></td>
      </tr>`;
    }).join("");

    box.className = "dialog-inner detail";
    box.innerHTML = `
      <header class="dialog-head">
        <div><h3>${esc(a.name || a.ticker)}</h3><div class="sub">${esc([a.ticker, a.exchange, a.currency && `quoted in ${a.currency}`].filter(Boolean).join(" · "))}</div></div>
        <button class="icon-btn" data-close aria-label="Close">${ICON.close}</button>
      </header>
      ${a.error ? `<p class="form-error">${esc(a.error)}</p>` : `
      <div class="detail-kpis">
        <div class="kpi"><div class="label">Value</div><div class="v num">${money(a.value)}</div><div class="s">${num(a.shares)} shares</div></div>
        <div class="kpi"><div class="label">Result</div><div class="v num ${tone(a.gain)}">${signedMoney(a.gain)}</div><div class="s ${tone(a.gain)}">${pct(a.return_pct, 2)}</div></div>
        <div class="kpi"><div class="label">Annual (XIRR)</div><div class="v num ${tone(a.annualized_pct)}">${pct(a.annualized_pct)}</div><div class="s">over ${held(a.held_days)}</div></div>
        <div class="kpi"><div class="label">12 months</div><div class="v num ${tone(a.yoy?.pct)}">${a.yoy ? pct(a.yoy.pct) : "—"}</div><div class="s">instrument ${pct(a.instrument_12m_pct)}</div></div>
      </div>
      <div class="chart" id="detail-chart"></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Amount</th><th>Price</th><th>Shares</th><th>Value today</th><th>Return</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">No contributions.</td></tr>`}</tbody>
      </table></div>`}
      <div class="detail-foot">
        <div class="meta">${a.last_date ? `Last price ${num(a.last_price, 4)} ${esc(a.currency)} on ${dateFmt(a.last_date)}` : ""}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm btn-danger" data-act="delete-asset">Delete asset</button>
          <button class="btn btn-sm" data-act="edit">${ICON.edit}Edit</button>
          ${a.error ? "" : `<button class="btn btn-sm btn-primary" data-act="capital">Add capital</button>`}
        </div>
      </div>`;
    if (!a.error) requestAnimationFrame(() => drawChart($("#detail-chart"), a.series, { axes: true, interactive: true }));

    box.querySelector("[data-close]").onclick = () => dlgDetail.close();
    box.querySelector('[data-act="capital"]')?.addEventListener("click", () => { dlgDetail.close(); openCapital(a.id); });
    box.querySelector('[data-act="edit"]').addEventListener("click", () => { dlgDetail.close(); openEdit(a.id); });
    const delBtn = box.querySelector('[data-act="delete-asset"]');
    delBtn.addEventListener("click", () => deleteAsset(delBtn, a.id, () => dlgDetail.close()));
    $$("[data-edit-c]", box).forEach((b) => b.addEventListener("click", () => { dlgDetail.close(); openEdit(a.id, b.dataset.editC); }));
  }

  // ------------------------------------------------------------------ theme ----
  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function toggleTheme() {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store("it-theme", next);
    if (state.data) { renderOverview(); drawSparks(); }
  }

  // ----------------------------------------------------------------- events ----
  $("#btn-add").addEventListener("click", openAdd);
  $("#btn-refresh").addEventListener("click", () => load(true));
  $("#btn-theme").addEventListener("click", toggleTheme);
  $("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); runSearch(); } });
  $("#add-back").addEventListener("click", () => { $("#step-search").hidden = false; $("#step-details").hidden = true; $("#q").focus(); });
  const isCancel = (e) => e.submitter && e.submitter.value === "cancel";
  $("#form-add").addEventListener("submit", (e) => { if (!isCancel(e)) submitAdd(e); });
  $("#form-capital").addEventListener("submit", (e) => { if (!isCancel(e)) submitCapital(e); });
  $("#form-edit").addEventListener("submit", (e) => { if (!isCancel(e)) submitEdit(e); });
  $("#edit-add-row").addEventListener("click", () => {
    const row = editRow({});
    $("#edit-rows").appendChild(row);
    row.scrollIntoView({ block: "nearest" });
    row.querySelector('input[name="amount"]').focus();
  });
  $("#edit-ticker").addEventListener("input", () => {
    const a = findAsset(state.editFor);
    $("#edit-ticker-hint").hidden = !a || $("#edit-ticker").value.trim().toUpperCase() === a.ticker;
  });
  $("#edit-delete").addEventListener("click", (e) => deleteAsset(e.currentTarget, state.editFor, () => dlgEdit.close()));
  for (const dlg of [dlgCap, dlgEdit]) $$("[data-close]", dlg).forEach((b) => b.addEventListener("click", () => dlg.close()));
  for (const dlg of [dlgAdd, dlgCap, dlgEdit, dlgDetail]) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click on the backdrop
  }
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; store("it-sort", state.sort); renderGrid(); });
  $("#range").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    state.range = Number(b.dataset.range);
    renderOverview();
  });
  $("#grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (b.dataset.act === "add") return openAdd();
    const id = b.closest("[data-id]")?.dataset.id;
    if (b.dataset.act === "capital") openCapital(id);
    if (b.dataset.act === "edit") openEdit(id);
    if (b.dataset.act === "detail") openDetail(id);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.data) { renderOverview(); drawSparks(); } });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data) { renderOverview(); drawSparks(); if (dlgDetail.open) renderDetail(state.detailId); } }, 120);
  });
  setInterval(() => updateSync(), 30000);

  load();
})();
