"use strict";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n, d = 3) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const LS_KEY = "satisfactory-planner:current";

let DATA = null;           // game data from /api/data
const items = {}, recipes = {}, buildings = {}, nameToItem = {};
let plan = null;           // the plan being edited
let result = null;         // last solver result
let dirty = false;
let savedId = "";

// ---------------------------------------------------------------- plan model

function blankPlan() {
  return {
    name: "",
    targets: [{ item: "", rate: 10 }],
    inputs: [],
    settings: { objective: "resources", limitRaw: true },
    recipes: { enabled: [], disabled: [] },
  };
}

function normalizePlan(p) {
  const base = blankPlan();
  const rows = (list) => (Array.isArray(list) ? list : [])
    .map((r) => ({ item: items[r?.item] ? r.item : "", rate: Number(r?.rate) || 0 }));
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => recipes[id]) : []);
  return {
    name: typeof p?.name === "string" ? p.name : "",
    targets: rows(p?.targets),
    inputs: rows(p?.inputs),
    settings: { ...base.settings, ...(p?.settings || {}) },
    recipes: { enabled: ids(p?.recipes?.enabled), disabled: ids(p?.recipes?.disabled) },
  };
}

function isRecipeOn(r) {
  const { enabled, disabled } = plan.recipes;
  return (r.defaultEnabled || enabled.includes(r.id)) && !disabled.includes(r.id);
}

function setRecipe(r, on) {
  const en = new Set(plan.recipes.enabled), dis = new Set(plan.recipes.disabled);
  en.delete(r.id); dis.delete(r.id);
  if (on && !r.defaultEnabled) en.add(r.id);
  if (!on && r.defaultEnabled) dis.add(r.id);
  plan.recipes = { enabled: [...en].sort(), disabled: [...dis].sort() };
}

function persist() { localStorage.setItem(LS_KEY, JSON.stringify({ plan, savedId, dirty })); }

function changed() {
  dirty = true;
  persist();
  updateStatus();
  scheduleSolve();
}

// ---------------------------------------------------------------- sidebar UI

function unit(itemId) { return items[itemId]?.fluid ? "m³/min" : "/min"; }

function renderRows(container, list) {
  container.innerHTML = "";
  list.forEach((row, idx) => {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = `
      <input class="item" list="itemNames" placeholder="Search item…" value="${esc(items[row.item]?.name || "")}" aria-label="Item">
      <input class="rate" type="number" min="0" step="any" value="${row.rate}" title="Rate per minute" aria-label="Rate per minute">
      <button class="remove" title="Remove" aria-label="Remove">✕</button>`;
    const itemInput = el.querySelector(".item"), rateInput = el.querySelector(".rate");
    const unitHint = () => { rateInput.title = `Rate (${unit(row.item)})`; };
    unitHint();
    itemInput.addEventListener("change", () => {
      const id = nameToItem[itemInput.value.trim().toLowerCase()];
      itemInput.classList.toggle("invalid", !id && itemInput.value.trim() !== "");
      row.item = id || "";
      unitHint();
      changed();
    });
    rateInput.addEventListener("input", () => { row.rate = Number(rateInput.value) || 0; changed(); });
    el.querySelector(".remove").addEventListener("click", () => { list.splice(idx, 1); renderRows(container, list); changed(); });
    container.appendChild(el);
  });
}

function renderSidebar() {
  $("#planName").value = plan.name;
  renderRows($("#targets"), plan.targets);
  renderRows($("#inputs"), plan.inputs);
  $("#objective").value = plan.settings.objective;
  $("#limitRaw").checked = plan.settings.limitRaw;
  renderRecipes();
}

function ioText(list) {
  return list.map((p) => `<b>${fmt(p.amount)}</b> ${esc(items[p.item].name)}`).join(", ");
}

function renderRecipes() {
  const q = $("#recipeSearch").value.trim().toLowerCase();
  const filter = $("#recipeFilter").value;
  const used = new Set((result?.rows || []).map((r) => r.recipe));
  const list = DATA.recipes.filter((r) => {
    const on = isRecipeOn(r);
    if (filter === "alt" && r.defaultEnabled) return false;
    if (filter === "on" && !on) return false;
    if (filter === "off" && on) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) ||
      [...r.products, ...r.ingredients].some((p) => items[p.item].name.toLowerCase().includes(q));
  });
  const box = $("#recipeList");
  box.innerHTML = list.map((r) => `
    <label class="recipe${used.has(r.id) ? " used" : ""}">
      <input type="checkbox" data-id="${esc(r.id)}" ${isRecipeOn(r) ? "checked" : ""}>
      <div>
        <div class="name">${esc(r.name)}</div>
        <div class="io">${ioText(r.ingredients)} → ${ioText(r.products)}<br>${esc(buildings[r.building].name)} · ${fmt(r.duration)}s</div>
      </div>
    </label>`).join("") || `<div class="recipe"><span></span><span class="hint">No recipes match.</span></div>`;
  const alts = DATA.recipes.filter((r) => !r.defaultEnabled);
  $("#recipeCount").textContent = `${alts.filter(isRecipeOn).length}/${alts.length} non-default enabled`;
}

// ---------------------------------------------------------------- solving

let solveTimer = null, solveSeq = 0;
function scheduleSolve() {
  clearTimeout(solveTimer);
  solveTimer = setTimeout(runSolve, 250);
}

async function runSolve() {
  const seq = ++solveSeq;
  try {
    const res = await fetch("/api/solve", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(plan),
    });
    if (!res.ok) throw new Error(`Solver error (${res.status})`);
    const r = await res.json();
    if (seq !== solveSeq) return;
    result = r.status === "ok" ? r : null;
    renderResults(r);
  } catch (e) {
    if (seq === solveSeq) renderResults({ status: "error", message: e.message });
  }
}

function renderResults(r) {
  const msg = $("#message");
  if (r.status !== "ok") {
    msg.hidden = false;
    msg.className = r.status === "empty" ? "message info" : "message";
    msg.textContent = r.message;
    $("#summary").innerHTML = "";
    $("#machinesTable").innerHTML = "";
    $("#itemsTable").innerHTML = "";
    $("#graph").innerHTML = "";
    renderRecipes();
    return;
  }
  msg.hidden = true;
  renderSummary(r);
  renderMachines(r);
  renderItems(r);
  renderGraph(r.graph);
  renderRecipes();
}

function itemList(list) {
  return list.map((x) => `<li><span>${esc(items[x.item].name)}</span><span>${fmt(x.rate, 2)} ${unit(x.item)}</span></li>`).join("");
}

function renderSummary(r) {
  const parts = [
    `<div class="card"><div class="label">Power</div><div class="value">${fmt(r.totals.power, 1)} MW</div></div>`,
    `<div class="card"><div class="label">Machines (at 100%)</div><div class="value">${fmt(r.totals.machines, 2)}</div></div>`,
    `<div class="card wide"><div class="label">Raw resources</div><ul>${itemList(r.raw) || "<li>None</li>"}</ul></div>`,
  ];
  if (r.surplus.length) parts.push(`<div class="card wide"><div class="label">Surplus / byproducts</div><ul>${itemList(r.surplus)}</ul></div>`);
  if (r.inputs.length) parts.push(`<div class="card wide"><div class="label">Supplied inputs used</div><ul>${itemList(r.inputs)}</ul></div>`);
  $("#summary").innerHTML = parts.join("");
}

function flows(list) {
  return list.map((p) => `<b>${fmt(p.rate, 2)}</b> ${esc(items[p.item].name)}`).join("<br>");
}

function clockHint(count) {
  const n = Math.ceil(count - 1e-6);
  return n > 0 ? `${n} at ${fmt((count / n) * 100, 1)}%` : "";
}

function renderMachines(r) {
  $("#machinesTable").innerHTML = `
    <thead><tr><th>Recipe</th><th>Building</th><th class="num">Machines</th><th class="num">Power</th><th>Inputs /min</th><th>Outputs /min</th></tr></thead>
    <tbody>${r.rows.map((row) => {
      const rec = recipes[row.recipe];
      return `<tr>
        <td>${esc(rec.name)}${rec.defaultEnabled ? "" : `<span class="tag alt">${rec.alternate ? "alt" : "special"}</span>`}</td>
        <td>${esc(buildings[row.building].name)}</td>
        <td class="num">${fmt(row.machines, 3)}<div class="hint">${clockHint(row.machines)}</div></td>
        <td class="num">${fmt(row.power, 1)} MW</td>
        <td class="flows">${flows(row.inputs)}</td>
        <td class="flows">${flows(row.outputs)}</td>
      </tr>`;
    }).join("")}</tbody>`;
}

function renderItems(r) {
  const acc = {};
  const get = (id) => (acc[id] ||= { produced: 0, consumed: 0 });
  r.rows.forEach((row) => {
    row.outputs.forEach((p) => (get(p.item).produced += p.rate));
    row.inputs.forEach((p) => (get(p.item).consumed += p.rate));
  });
  r.raw.forEach((p) => (get(p.item).raw = p.rate));
  r.inputs.forEach((p) => (get(p.item).supplied = p.rate));
  r.targets.forEach((p) => (get(p.item).target = p.rate));
  r.surplus.forEach((p) => (get(p.item).surplus = p.rate));
  const cell = (v, id) => (v ? `${fmt(v, 2)}` : "");
  const rows = Object.entries(acc).sort((a, b) => items[a[0]].name.localeCompare(items[b[0]].name));
  $("#itemsTable").innerHTML = `
    <thead><tr><th>Item</th><th class="num">Raw</th><th class="num">Supplied</th><th class="num">Produced</th><th class="num">Consumed</th><th class="num">Target</th><th class="num">Surplus</th><th>Unit</th></tr></thead>
    <tbody>${rows.map(([id, a]) => `<tr>
      <td>${esc(items[id].name)}</td>
      <td class="num">${cell(a.raw)}</td><td class="num">${cell(a.supplied)}</td>
      <td class="num">${cell(a.produced)}</td><td class="num">${cell(a.consumed)}</td>
      <td class="num">${cell(a.target)}</td><td class="num">${cell(a.surplus)}</td>
      <td class="hint">${unit(id)}</td></tr>`).join("")}</tbody>`;
}

// ---------------------------------------------------------------- graph

const NODE_W = 190, NODE_H = 48, COL_GAP = 100, ROW_GAP = 22;
const MAX_FIT_ZOOM_OUT = 1.6; // keep labels readable; pan for the rest
const KIND_COLOR = { raw: "var(--raw)", input: "var(--input)", recipe: "var(--recipe)", target: "var(--target)", surplus: "var(--surplus)" };
let view = null, graphBounds = null;

function layout(graph) {
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, { ...n, out: [], inc: [] }]));
  graph.edges.forEach((e) => { byId[e.from].out.push(e); byId[e.to].inc.push(e); });

  // Break cycles: DFS from sources, ignore edges back onto the stack.
  const order = Object.values(byId).sort((a, b) => (a.inc.length - b.inc.length));
  const state = {}, back = new Set();
  const visit = (n) => {
    state[n.id] = 1;
    for (const e of n.out) {
      if (state[e.to] === 1) back.add(e);
      else if (!state[e.to]) visit(byId[e.to]);
    }
    state[n.id] = 2;
  };
  order.forEach((n) => { if (!state[n.id]) visit(n); });

  // Longest path layering over the acyclic edges.
  const layer = {};
  const depth = (n) => {
    if (layer[n.id] !== undefined) return layer[n.id];
    layer[n.id] = 0;
    const preds = n.inc.filter((e) => !back.has(e));
    layer[n.id] = preds.length ? Math.max(...preds.map((e) => depth(byId[e.from]) + 1)) : 0;
    return layer[n.id];
  };
  Object.values(byId).forEach(depth);
  const maxLayer = Math.max(0, ...Object.values(byId).filter((n) => n.kind === "recipe").map((n) => layer[n.id]));
  Object.values(byId).forEach((n) => {
    if (n.kind === "target" || n.kind === "surplus") layer[n.id] = maxLayer + 1;
  });

  const cols = [];
  Object.values(byId).forEach((n) => (cols[layer[n.id]] ||= []).push(n));
  // Order within columns by the average position of their predecessors.
  const pos = {};
  cols.forEach((col) => col.forEach((n, i) => (pos[n.id] = i)));
  for (let pass = 0; pass < 4; pass++) {
    cols.forEach((col, ci) => {
      if (ci === 0) return;
      col.forEach((n) => {
        const ps = n.inc.filter((e) => layer[e.from] < ci).map((e) => pos[e.from]);
        n._bary = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos[n.id];
      });
      col.sort((a, b) => a._bary - b._bary || (a.kind === "surplus") - (b.kind === "surplus"));
      col.forEach((n, i) => (pos[n.id] = i));
    });
  }
  const tallest = Math.max(...cols.map((c) => (c ? c.length : 0)));
  cols.forEach((col, ci) => {
    if (!col) return;
    const offset = ((tallest - col.length) * (NODE_H + ROW_GAP)) / 2;
    col.forEach((n, i) => { n.x = ci * (NODE_W + COL_GAP); n.y = offset + i * (NODE_H + ROW_GAP); });
  });
  return { nodes: byId, edges: graph.edges };
}

function renderGraph(graph) {
  const svg = $("#graph");
  const { nodes, edges } = layout(graph);
  const maxRate = Math.max(1, ...edges.map((e) => e.rate));
  const ns = Object.values(nodes);
  const edgeSvg = edges.map((e) => {
    const a = nodes[e.from], b = nodes[e.to];
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    let d;
    if (x2 > x1) {
      const dx = (x2 - x1) / 2;
      d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    } else { // backwards edge (loop): route underneath
      const low = Math.max(a.y, b.y) + NODE_H + 40;
      d = `M${x1},${y1} C${x1 + 80},${y1} ${x1 + 80},${low} ${(x1 + x2) / 2},${low} S${x2 - 80},${y2} ${x2},${y2}`;
    }
    const w = 1.5 + 6 * Math.sqrt(e.rate / maxRate);
    const label = `${items[e.item].name} ${fmt(e.rate, 2)}`;
    const lx = (x1 + x2) / 2, ly = x2 > x1 ? (y1 + y2) / 2 - 4 : Math.max(a.y, b.y) + NODE_H + 36;
    return `<g class="edge"><title>${esc(label)} ${unit(e.item)}</title><path d="${d}" stroke-width="${w.toFixed(1)}"/>
      <text x="${lx}" y="${ly}" text-anchor="middle">${esc(label)}</text></g>`;
  }).join("");
  const nodeSvg = ns.map((n) => {
    const fill = KIND_COLOR[n.kind];
    const isRecipe = n.kind === "recipe";
    const rate = n.kind === "recipe" ? "" : nodeRate(n, edges);
    const sub = n.sub || rate;
    return `<g class="node" transform="translate(${n.x},${n.y})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="6" fill="${isRecipe ? "var(--panel-2)" : fill}" fill-opacity="${isRecipe ? 1 : 0.22}" stroke="${isRecipe ? "var(--line)" : fill}"/>
      <text x="10" y="20">${esc(clip(n.label, 26))}</text>
      <text class="sub" x="10" y="37">${esc(clip(n.sub && rate ? `${rate} · ${n.sub}` : sub, 32))}</text>
      <title>${esc(n.label)}${n.sub ? " — " + esc(n.sub) : ""}</title></g>`;
  }).join("");
  svg.innerHTML = `<g class="edges">${edgeSvg}</g><g class="nodes">${nodeSvg}</g>`;

  const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
  graphBounds = ns.length
    ? { x: Math.min(...xs) - 30, y: Math.min(...ys) - 30, w: Math.max(...xs) - Math.min(...xs) + NODE_W + 60, h: Math.max(...ys) - Math.min(...ys) + NODE_H + 110 }
    : { x: 0, y: 0, w: 100, h: 100 };
  if (!view) fitGraph(); else applyView();
}

function nodeRate(n, edges) {
  const out = edges.filter((e) => e.from === n.id).reduce((s, e) => s + e.rate, 0);
  const inc = edges.filter((e) => e.to === n.id).reduce((s, e) => s + e.rate, 0);
  const iid = n.id.split(":")[1];
  return `${fmt(Math.max(out, inc), 2)} ${unit(iid)}`;
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function fitGraph() {
  const svg = $("#graph");
  const r = svg.getBoundingClientRect();
  const b = graphBounds || { x: 0, y: 0, w: 100, h: 100 };
  const fit = Math.max(b.w / Math.max(r.width, 1), b.h / Math.max(r.height, 1));
  const scale = Math.max(1, Math.min(fit, MAX_FIT_ZOOM_OUT));
  const w = r.width * scale, h = r.height * scale;
  // Centre when it fits; otherwise start from the raw-resource (left) side.
  const x = w >= b.w ? b.x - (w - b.w) / 2 : b.x;
  const y = h >= b.h ? b.y - (h - b.h) / 2 : b.y;
  view = { x, y, w, h };
  applyView();
}

function applyView() { $("#graph").setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`); }

function setupGraphPanZoom() {
  const svg = $("#graph");
  let drag = null;
  svg.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, v: { ...view } }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener("pointermove", (e) => {
    if (!drag || !view) return;
    const k = view.w / svg.getBoundingClientRect().width;
    view.x = drag.v.x - (e.clientX - drag.x) * k;
    view.y = drag.v.y - (e.clientY - drag.y) * k;
    applyView();
  });
  svg.addEventListener("pointerup", () => (drag = null));
  svg.addEventListener("wheel", (e) => {
    if (!view) return;
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const f = Math.exp(e.deltaY * 0.0015);
    const px = view.x + ((e.clientX - r.left) / r.width) * view.w;
    const py = view.y + ((e.clientY - r.top) / r.height) * view.h;
    view = { x: px - (px - view.x) * f, y: py - (py - view.y) * f, w: view.w * f, h: view.h * f };
    applyView();
  }, { passive: false });
  $("#fitGraph").addEventListener("click", fitGraph);
  window.addEventListener("resize", () => { if (graphBounds) fitGraph(); });
}

// ---------------------------------------------------------------- saving

function setStatus(text, error = false) {
  const s = $("#status");
  s.textContent = text;
  s.classList.toggle("error", error);
}
function updateStatus() { setStatus(dirty ? "Unsaved changes" : savedId ? `Saved as plans/${savedId}.json` : ""); }

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}

async function refreshPlanList() {
  const list = await api("GET", "/api/plans");
  const sel = $("#planList");
  sel.innerHTML = `<option value="">Open saved plan…</option>` +
    list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.updated ? " — " + esc(new Date(p.updated).toLocaleString()) : ""}</option>`).join("");
}

async function savePlan() {
  if (!plan.name.trim()) {
    const name = prompt("Name this plan:");
    if (!name || !name.trim()) return;
    plan.name = name.trim();
    $("#planName").value = plan.name;
  }
  try {
    const r = await api("PUT", "/api/plans", plan);
    savedId = r.id; dirty = false;
    persist();
    await refreshPlanList();
    updateStatus();
  } catch (e) { setStatus(e.message, true); }
}

function loadPlan(p, id = "", isDirty = false) {
  plan = normalizePlan(p);
  if (!plan.targets.length) plan.targets.push({ item: "", rate: 10 });
  savedId = id; dirty = isDirty;
  view = null;
  persist();
  renderSidebar();
  updateStatus();
  runSolve();
}

function confirmDiscard() { return !dirty || confirm("Discard unsaved changes to this plan?"); }

function setupToolbar() {
  $("#planName").addEventListener("input", (e) => { plan.name = e.target.value; changed(); });
  $("#btnSave").addEventListener("click", savePlan);
  $("#btnNew").addEventListener("click", () => { if (confirmDiscard()) loadPlan(blankPlan()); });
  $("#planList").addEventListener("change", async (e) => {
    const id = e.target.value;
    e.target.value = "";
    if (!id || !confirmDiscard()) return;
    try { loadPlan(await api("GET", `/api/plans/${encodeURIComponent(id)}`), id); } catch (err) { setStatus(err.message, true); }
  });
  $("#btnDelete").addEventListener("click", async () => {
    if (!savedId) { setStatus("This plan hasn't been saved yet.", true); return; }
    if (!confirm(`Delete plans/${savedId}.json? This can't be undone.`)) return;
    try {
      await api("DELETE", `/api/plans/${encodeURIComponent(savedId)}`);
      savedId = ""; dirty = true; persist();
      await refreshPlanList();
      updateStatus();
    } catch (e) { setStatus(e.message, true); }
  });
  $("#btnExport").addEventListener("click", () => {
    const name = plan.name.trim() || "plan";
    const blob = new Blob([JSON.stringify({ ...plan, version: 1 }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#fileImport").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !confirmDiscard()) return;
    try {
      const p = JSON.parse(await file.text());
      if (!p || !Array.isArray(p.targets)) throw new Error("That file isn't a planner plan (no targets list).");
      loadPlan(p, "", true);
    } catch (err) { setStatus(`Import failed: ${err.message}`, true); }
  });
  window.addEventListener("beforeunload", (e) => { if (dirty) e.preventDefault(); });
}

function setupSidebar() {
  $("#addTarget").addEventListener("click", () => { plan.targets.push({ item: "", rate: 10 }); renderRows($("#targets"), plan.targets); $("#targets .row:last-child .item").focus(); });
  $("#addInput").addEventListener("click", () => { plan.inputs.push({ item: "", rate: 60 }); renderRows($("#inputs"), plan.inputs); $("#inputs .row:last-child .item").focus(); });
  $("#objective").addEventListener("change", (e) => { plan.settings.objective = e.target.value; changed(); });
  $("#limitRaw").addEventListener("change", (e) => { plan.settings.limitRaw = e.target.checked; changed(); });
  $("#recipeSearch").addEventListener("input", renderRecipes);
  $("#recipeFilter").addEventListener("change", renderRecipes);
  $("#recipeList").addEventListener("change", (e) => {
    const r = recipes[e.target.dataset.id];
    if (r) { setRecipe(r, e.target.checked); changed(); renderRecipes(); }
  });
  $("#altAll").addEventListener("click", () => {
    plan.recipes.enabled = DATA.recipes.filter((r) => r.alternate).map((r) => r.id);
    plan.recipes.disabled = [];
    changed(); renderRecipes();
  });
  $("#altReset").addEventListener("click", () => { plan.recipes = { enabled: [], disabled: [] }; changed(); renderRecipes(); });
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button, .tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $(`#tab-${b.dataset.tab}`).classList.add("active");
    if (b.dataset.tab === "graph") fitGraph();
  }));
}

// ---------------------------------------------------------------- boot

async function boot() {
  DATA = await api("GET", "/api/data");
  DATA.items.forEach((i) => { items[i.id] = i; nameToItem[i.name.toLowerCase()] = i.id; });
  DATA.recipes.forEach((r) => (recipes[r.id] = r));
  DATA.buildings.forEach((b) => (buildings[b.id] = b));
  $("#itemNames").innerHTML = DATA.items.map((i) => `<option value="${esc(i.name)}">`).join("");

  setupToolbar();
  setupSidebar();
  setupGraphPanZoom();
  await refreshPlanList().catch((e) => setStatus(e.message, true));

  const linked = new URLSearchParams(location.search).get("plan");
  if (linked) {
    try { loadPlan(await api("GET", `/api/plans/${encodeURIComponent(linked)}`), linked); return; }
    catch (e) { setStatus(`Couldn't open plan "${linked}": ${e.message}`, true); }
  }
  let restored = null;
  try { restored = JSON.parse(localStorage.getItem(LS_KEY)); } catch { /* ignore */ }
  if (restored?.plan) {
    loadPlan(restored.plan, restored.savedId || "", !!restored.dirty);
  } else {
    const start = blankPlan();
    start.targets = [{ item: "Desc_IronPlateReinforced_C", rate: 5 }];
    loadPlan(start);
  }
}

boot().catch((e) => setStatus(`Failed to start: ${e.message}`, true));
