/* Investment Tracker — logica della dashboard. Vanilla JS, nessuna dipendenza esterna. */
(() => {
  "use strict";

  const TOKEN = document.querySelector('meta[name="tracker-token"]').content;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const state = {
    data: null,
    loadedAt: null,
    range: 0,
    sort: store("it-sort") || "value",
    capitalFor: null,
    picked: null,
  };

  // ------------------------------------------------------------ utilità ----
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
    try { data = await res.json(); } catch (e) { /* risposta vuota */ }
    if (!res.ok) throw new Error(data.error || `Errore ${res.status}`);
    return data;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cur = () => (state.data && state.data.base_currency) || "EUR";
  const fmtCache = {};
  function money(v, dec) {
    if (v == null || isNaN(v)) return "—";
    if (dec == null) dec = Math.abs(v) >= 10000 ? 0 : 2;
    const k = cur() + dec;
    fmtCache[k] = fmtCache[k] || new Intl.NumberFormat("it-IT", { style: "currency", currency: cur(), minimumFractionDigits: dec, maximumFractionDigits: dec });
    return fmtCache[k].format(v);
  }
  const signedMoney = (v, dec) => (v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v), dec));
  const pct = (v, dec = 1) => (v == null || isNaN(v) ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec }) + "%");
  const num = (v, dec = 4) => (v == null ? "—" : v.toLocaleString("it-IT", { maximumFractionDigits: dec }));
  const tone = (v) => (v == null ? "" : v >= 0 ? "pos" : "neg");
  const dateIT = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };
  const monthIT = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("it-IT", { month: "short", year: "2-digit" });
  const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const parseNum = (s) => { s = String(s || "").trim().replace(/\s|€/g, ""); if (s.includes(",")) s = s.replace(/\./g, "").replace(",", "."); return s === "" ? null : Number(s); };
  const held = (days) => days >= 365 ? `${(days / 365).toLocaleString("it-IT", { maximumFractionDigits: 1 })} anni` : `${Math.max(days, 0)} giorni`;

  function toast(msg, isErr = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove("show"), isErr ? 5000 : 2600);
  }

  // ------------------------------------------------------------- grafici ----
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

  const compact = (v) => new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }).format(v);

  /**
   * Disegna un grafico SVG del valore (linea + area) con capitale versato tratteggiato.
   * opts: { axes, interactive, color }
   */
  function drawChart(el, series, opts = {}) {
    el.innerHTML = "";
    if (!series || series.dates.length < 2) {
      el.innerHTML = `<div class="hint" style="padding:20px 0">Dati insufficienti per il grafico.</div>`;
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
    // capitale versato come gradini
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
        axes += `<text class="axis-text" x="${x(i)}" y="${H - 6}" text-anchor="${anchor}">${monthIT(series.dates[i])}</text>`;
      }
    }

    el.innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Andamento del valore">
        <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style="stop-color:${color};stop-opacity:.22"/>
          <stop offset="1" style="stop-color:${color};stop-opacity:0"/>
        </linearGradient></defs>
        ${axes}
        <path d="${area}" fill="url(#${gid})"/>
        ${opts.axes || opts.showInvested ? `<path class="line-invested" d="${inv}"/>` : ""}
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
      tip.innerHTML = `<div class="d">${dateIT(series.dates[i])}</div>
        <div class="r"><span>Valore</span><span>${money(v)}</span></div>
        <div class="r"><span>Versato</span><span>${money(iv)}</span></div>
        <div class="r"><span>Risultato</span><span class="${tone(gain)}">${signedMoney(gain)} · ${pct(iv ? (gain / iv) * 100 : 0)}</span></div>`;
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
      <div class="kpi"><div class="label">Capitale versato</div><div class="v num">${money(s.invested)}</div><div class="s">${s.asset_count} asset</div></div>
      <div class="kpi"><div class="label">Valore attuale</div><div class="v num ${tone(s.gain)}">${money(s.value)}</div><div class="s">${s.error_count ? `<span class="neg">${s.error_count} asset senza dati</span>` : "ai prezzi di chiusura"}</div></div>
      <div class="kpi"><div class="label">Guadagno</div><div class="v num ${tone(s.gain)}">${signedMoney(s.gain)}</div><div class="s"><b class="${tone(s.gain)}">${pct(s.return_pct, 2)}</b> sul versato</div></div>
      <div class="kpi"><div class="label">Rendimento annuo</div><div class="v num ${tone(s.annualized_pct)}">${pct(s.annualized_pct)}</div><div class="s">money-weighted (XIRR)</div></div>
      <div class="kpi"><div class="label">Ultimi 12 mesi</div><div class="v num ${tone(s.yoy_pct)}">${pct(s.yoy_pct)}</div><div class="s">${s.yoy_gain == null ? "serve almeno 1 anno" : `<b class="${tone(s.yoy_gain)}">${signedMoney(s.yoy_gain)}</b> YoY`}</div></div>`;
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
      <div class="alloc-legend">${ok.map((a, i) => `<span><i style="background:${col(i)}"></i>${esc(shortName(a))} <b>${((a.value / total) * 100).toLocaleString("it-IT", { maximumFractionDigits: 1 })}%</b></span>`).join("")}</div>`;
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
    const meta = [a.ticker, a.exchange, a.first_date ? "dal " + dateIT(a.first_date) : ""].filter(Boolean).map(esc).join(" · ");
    if (a.error) {
      return `<article class="card asset is-error" data-id="${a.id}">
        <div class="asset-top"><div class="mono">${letter}</div><div class="asset-name"><div class="n">${esc(shortName(a))}</div><div class="m">${meta}</div></div></div>
        <div class="err">${esc(a.error)}</div>
        <div class="asset-actions"><button class="btn btn-sm" data-act="detail">Dettagli</button></div>
      </article>`;
    }
    const n = a.contributions.length;
    const yoy = a.yoy;
    return `<article class="card asset ${a.gain < 0 ? "is-neg" : ""}" data-id="${a.id}">
      <div class="asset-top">
        <div class="mono">${letter}</div>
        <div class="asset-name"><div class="n" title="${esc(a.name)}">${esc(shortName(a))}</div><div class="m">${meta}</div></div>
        <span class="chip ${tone(a.day_change_pct)}" title="Variazione dell'ultima seduta">${pct(a.day_change_pct, 2)} oggi</span>
      </div>
      <div class="asset-mid">
        <div>
          <div class="label">Valore</div>
          <div class="v num">${money(a.value)}</div>
          <div class="d ${tone(a.gain)}">${pct(a.return_pct, 2)} · ${signedMoney(a.gain)}</div>
        </div>
        <div class="spark" data-spark="${a.id}"></div>
      </div>
      <div class="asset-stats">
        <div><div class="label">Versato</div><div class="v">${money(a.invested)}</div><div class="s">${n} versament${n === 1 ? "o" : "i"}</div></div>
        <div><div class="label">Annuo</div><div class="v ${tone(a.annualized_pct)}">${pct(a.annualized_pct)}</div><div class="s">${a.annualized_pct == null ? "dopo 6 mesi" : "XIRR"}</div></div>
        <div><div class="label">12 mesi</div><div class="v ${tone(yoy?.pct)}">${yoy ? pct(yoy.pct) : "—"}</div><div class="s ${yoy ? tone(yoy.gain) : ""}">${yoy ? signedMoney(yoy.gain, 0) : held(a.held_days) + " di storico"}</div></div>
      </div>
      <div class="asset-actions">
        <button class="btn btn-sm" data-act="capital"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Aggiungi capitale</button>
        <button class="btn btn-sm btn-ghost" data-act="detail">Dettagli</button>
      </div>
    </article>`;
  }

  function renderGrid() {
    const d = state.data;
    $("#eyebrow").textContent = `Portafoglio · ${d.assets.length} asset`;
    $("#demo-banner").hidden = !d.demo;
    $("#assets-head").hidden = !d.assets.length;
    $("#sort").value = state.sort;
    if (!d.assets.length) {
      $("#grid").innerHTML = `<div class="empty">
        <h3>Nessun asset ancora</h3>
        <p>Aggiungi il primo investimento: cerca il ticker o l'ISIN, indica data di inizio e capitale. I versamenti successivi (PAC) li aggiungi dalla card dell'asset.</p>
        <button class="btn btn-primary" data-act="add"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Aggiungi asset</button>
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
    if (status === "loading") { el.classList.add("loading"); txt.textContent = "Aggiornamento prezzi…"; return; }
    if (status === "error") { el.classList.add("error"); txt.textContent = "Errore di aggiornamento"; return; }
    if (!state.loadedAt || !state.data) return;
    const last = state.data.assets.map((a) => a.last_date).filter(Boolean).sort().pop();
    const mins = Math.round((Date.now() - state.loadedAt) / 60000);
    txt.textContent = (last ? `Prezzi al ${dateIT(last)} · ` : "") + (mins < 1 ? "aggiornato ora" : `aggiornato ${mins} min fa`);
  }

  // ------------------------------------------------------------ caricamento ----
  async function load(refresh = false) {
    updateSync("loading");
    $("#btn-refresh").classList.add("spinning");
    if (!state.data) $("#grid").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
    try {
      state.data = await api("GET", "/api/portfolio" + (refresh ? "?refresh=1" : ""));
      state.loadedAt = Date.now();
      renderAll();
      if (refresh) toast("Prezzi aggiornati");
    } catch (e) {
      updateSync("error");
      toast(e.message, true);
      if (!state.data) $("#grid").innerHTML = `<div class="empty"><h3>Impossibile caricare il portafoglio</h3><p>${esc(e.message)}</p></div>`;
    } finally {
      $("#btn-refresh").classList.remove("spinning");
    }
  }

  // ------------------------------------------------------- aggiungi asset ----
  const dlgAdd = $("#dlg-add");
  let searchTimer, searchSeq = 0;

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
    $("#results").innerHTML = `<li class="msg">Ricerca…</li>`;
    try {
      const r = await api("GET", "/api/search?q=" + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      const items = r.results.slice(0, 10);
      // ticker digitato esattamente ma non tra i risultati: permetti comunque di usarlo
      if (!r.is_isin && /^[A-Za-z0-9.\-=^]{1,20}$/.test(q) && !items.some((x) => x.symbol.toUpperCase() === q.toUpperCase())) {
        items.push({ symbol: q.toUpperCase(), name: "Usa questo ticker così com'è", exchange: "" });
      }
      $("#results").innerHTML = items.length
        ? items.map((x, i) => `<li><button type="button" data-i="${i}"><span class="sym">${esc(x.symbol)}</span><span class="nm">${esc(x.name)}</span><span class="ex">${esc(x.exchange)}</span></button></li>`).join("")
        : `<li class="msg">Nessun risultato. Prova con il ticker Yahoo (es. VWCE.DE).</li>`;
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
    if (!amount || amount <= 0) { err.textContent = "Inserisci un capitale valido."; err.hidden = false; return; }
    const btn = $("#add-save");
    btn.disabled = true; btn.textContent = "Verifica su Yahoo…";
    try {
      const r = await api("POST", "/api/assets", {
        ticker: state.picked.symbol,
        name: state.picked.name === "Usa questo ticker così com'è" ? "" : state.picked.name,
        exchange: state.picked.exchange,
        input_symbol: state.picked.input_symbol,
        date: $("#add-date").value,
        amount, price,
      });
      dlgAdd.close();
      toast(r.merged ? "Asset già presente: aggiunto come nuovo versamento" : "Asset aggiunto");
      await load();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = "Aggiungi al portafoglio";
    }
  }

  // ----------------------------------------------------- aggiungi capitale ----
  const dlgCap = $("#dlg-capital");

  function openCapital(id) {
    const a = state.data.assets.find((x) => x.id === id);
    if (!a) return;
    state.capitalFor = id;
    $("#form-capital").reset();
    $("#cap-error").hidden = true;
    $("#cap-asset").textContent = `${shortName(a)} · ${a.ticker}`;
    $("#cap-date").value = todayISO();
    $("#cap-date").max = todayISO();
    const last = a.contributions.length ? a.contributions[a.contributions.length - 1].amount : null;
    const amounts = [...new Set([last, 100, 250, 500].filter(Boolean))].slice(0, 4);
    $("#cap-quick").innerHTML = amounts.map((v, i) => `<button type="button" class="btn btn-sm" data-v="${v}">${i === 0 && v === last ? "Come l'ultimo · " : ""}${money(v, 0)}</button>`).join("");
    $$("#cap-quick button").forEach((b) => b.addEventListener("click", () => { $("#cap-amount").value = String(b.dataset.v).replace(".", ","); }));
    dlgCap.showModal();
    $("#cap-amount").focus();
  }

  async function submitCapital(ev) {
    ev.preventDefault();
    const err = $("#cap-error");
    err.hidden = true;
    const amount = parseNum($("#cap-amount").value);
    if (!amount || amount <= 0) { err.textContent = "Inserisci un importo valido."; err.hidden = false; return; }
    try {
      await api("POST", `/api/assets/${state.capitalFor}/contributions`, {
        date: $("#cap-date").value,
        amount,
        price: parseNum($("#cap-price").value),
        note: $("#cap-note").value.trim(),
      });
      dlgCap.close();
      toast(`Versamento di ${money(amount)} registrato`);
      await load();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
  }

  // -------------------------------------------------------------- dettaglio ----
  const dlgDetail = $("#dlg-detail");
  const trash = `<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

  function openDetail(id) {
    state.detailId = id;
    renderDetail(id);
    if (!dlgDetail.open) dlgDetail.showModal();
  }

  function renderDetail(id) {
    const a = state.data.assets.find((x) => x.id === id);
    const box = $("#detail");
    if (!a) { dlgDetail.close(); return; }
    const rows = [...(a.contributions || [])].reverse().map((c) => {
      const pl = c.value_now - c.amount;
      return `<tr>
        <td>${dateIT(c.date)}${c.note ? `<span class="note">${esc(c.note)}</span>` : ""}</td>
        <td>${money(c.amount)}</td>
        <td title="Eseguito il ${dateIT(c.exec_date)}${c.price_input ? " (prezzo inserito)" : " (chiusura)"}">${money(c.exec_price, 2)}${c.price_input ? " ✓" : ""}</td>
        <td>${num(c.shares)}</td>
        <td>${money(c.value_now)}</td>
        <td class="${tone(pl)}">${pct((pl / c.amount) * 100)}</td>
        <td><button class="del" data-del="${c.id}" title="Elimina versamento" aria-label="Elimina versamento">${trash}</button></td>
      </tr>`;
    }).join("");

    box.className = "dialog-inner detail";
    box.innerHTML = `
      <header class="dialog-head">
        <div><h3>${esc(a.name || a.ticker)}</h3><div class="sub">${esc([a.ticker, a.exchange, a.currency && `quotato in ${a.currency}`].filter(Boolean).join(" · "))}</div></div>
        <button class="icon-btn" data-close aria-label="Chiudi"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      ${a.error ? `<p class="form-error">${esc(a.error)}</p>` : `
      <div class="detail-kpis">
        <div class="kpi"><div class="label">Valore</div><div class="v num">${money(a.value)}</div><div class="s">${num(a.shares)} quote</div></div>
        <div class="kpi"><div class="label">Risultato</div><div class="v num ${tone(a.gain)}">${signedMoney(a.gain)}</div><div class="s ${tone(a.gain)}">${pct(a.return_pct, 2)}</div></div>
        <div class="kpi"><div class="label">Annuo (XIRR)</div><div class="v num ${tone(a.annualized_pct)}">${pct(a.annualized_pct)}</div><div class="s">in ${held(a.held_days)}</div></div>
        <div class="kpi"><div class="label">12 mesi</div><div class="v num ${tone(a.yoy?.pct)}">${a.yoy ? pct(a.yoy.pct) : "—"}</div><div class="s">strumento ${pct(a.instrument_12m_pct)}</div></div>
      </div>
      <div class="chart" id="detail-chart"></div>`}
      <div class="table-wrap"><table>
        <thead><tr><th>Data</th><th>Importo</th><th>Prezzo</th><th>Quote</th><th>Valore oggi</th><th>Rend.</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">Nessun versamento.</td></tr>`}</tbody>
      </table></div>
      <div class="detail-foot">
        <div class="meta">${a.last_date ? `Ultimo prezzo ${num(a.last_price, 4)} ${esc(a.currency)} al ${dateIT(a.last_date)}` : ""}</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-danger" data-act="delete-asset">Elimina asset</button>
          ${a.error ? "" : `<button class="btn btn-sm btn-primary" data-act="capital">Aggiungi capitale</button>`}
        </div>
      </div>`;
    if (!a.error) requestAnimationFrame(() => drawChart($("#detail-chart"), a.series, { axes: true, interactive: true }));

    box.querySelector("[data-close]").onclick = () => dlgDetail.close();
    box.querySelector('[data-act="capital"]')?.addEventListener("click", () => { dlgDetail.close(); openCapital(a.id); });
    const delBtn = box.querySelector('[data-act="delete-asset"]');
    delBtn.addEventListener("click", async () => {
      if (!delBtn.classList.contains("armed")) {
        delBtn.classList.add("armed"); delBtn.textContent = "Conferma eliminazione";
        setTimeout(() => { delBtn.classList.remove("armed"); delBtn.textContent = "Elimina asset"; }, 4000);
        return;
      }
      try { await api("DELETE", `/api/assets/${a.id}`); dlgDetail.close(); toast("Asset eliminato"); await load(); }
      catch (e) { toast(e.message, true); }
    });
    $$("[data-del]", box).forEach((b) => b.addEventListener("click", async () => {
      if (!b.classList.contains("armed")) {
        b.classList.add("armed"); b.style.opacity = 1; b.style.color = "var(--neg)"; b.title = "Clicca di nuovo per confermare";
        setTimeout(() => { b.classList.remove("armed"); b.style.opacity = ""; b.style.color = ""; }, 3000);
        return;
      }
      try {
        await api("DELETE", `/api/assets/${a.id}/contributions/${b.dataset.del}`);
        toast("Versamento eliminato");
        await load();
      } catch (e) { toast(e.message, true); }
    }));
  }

  // ------------------------------------------------------------------ tema ----
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

  // ---------------------------------------------------------------- eventi ----
  $("#btn-add").addEventListener("click", openAdd);
  $("#btn-refresh").addEventListener("click", () => load(true));
  $("#btn-theme").addEventListener("click", toggleTheme);
  $("#q").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); runSearch(); } });
  $("#add-back").addEventListener("click", () => { $("#step-search").hidden = false; $("#step-details").hidden = true; $("#q").focus(); });
  $("#form-add").addEventListener("submit", (e) => { if (e.submitter && e.submitter.value === "cancel") return; submitAdd(e); });
  $("#form-capital").addEventListener("submit", (e) => { if (e.submitter && e.submitter.value === "cancel") return; submitCapital(e); });
  $$("[data-close]", dlgCap).forEach((b) => b.addEventListener("click", () => dlgCap.close()));
  for (const dlg of [dlgAdd, dlgCap, dlgDetail]) {
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click sullo sfondo
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
