"use strict";
(() => {
  // ================= Réglages =================
  const TAX = 0.12;            // taxe de l'hôtel des ventes : 10 % sur la vente + 2 % de dépôt
  const DEFAULT_SERVER = "2302"; // Zikel · Europe · Asmodiens
  const PROF = { Blacksmithing: "Forge d'armes", Armorsmithing: "Forge d'armures", Handicrafting: "Artisanat", Alchemy: "Alchimie", Cooking: "Cuisine", Tailoring: "Couture", Conversion: "Conversion" };
  const CATS = [
    ["all", "Tout", null],
    ["weapon", "Armes", ["Weapons", "Weapon"]],
    ["armor", "Armures", ["Armor", "Gear"]],
    ["acc", "Accessoires", ["Accessories", "Accessory"]],
    ["wings", "Ailes", ["Wings"]],
    ["mat", "Matériaux", ["Materials", "Gatherable Material"]],
    ["cons", "Consommables", ["Consumables", "Food", "Usable"]],
    ["misc", "Divers", ["Special", "Decor", "Event"]],
  ];
  const GRADE_RANK = { Common: 0, Rare: 1, Epic: 2, Unique: 3, Heroic: 4, Legendary: 5, Legend: 5, Mythic: 6, Special: 2 };

  // ================= État =================
  let CAT = null, SERVERS = [], PR = { prices: {}, asOf: null };
  let server = null, faction = "asmodian";
  let overrides = load("atelier-overrides", {});
  let goalKey = null, haveKey = "", catFilter = "all";
  let GROUPS = new Map();      // clé de nom → { key, name, en, grade, ids: [], main, sub }
  let GROUP_OF = new Map();    // id → clé
  let RECIPES = [], BY_OUT = new Map(), BY_COMBO = new Map();

  function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // ================= Format =================
  const nf = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const kinah = n => n == null || !isFinite(n) ? "—" : Math.abs(n) >= 1e6 ? nf2.format(n / 1e6) + " M" : nf.format(Math.round(n));
  const full = n => n == null || !isFinite(n) ? "—" : nf.format(Math.round(n));
  const qtyFmt = q => Number.isInteger(q) ? nf.format(q) : nf2.format(q);
  const item = id => (CAT.items[id] || ["Objet #" + id, "", "", "", "", 0]);
  const nameOf = id => item(id)[0];
  const enOf = id => item(id)[1];
  const gradeOf = id => item(id)[2] || "Common";
  const gdot = id => `<span class="g ${esc(gradeOf(id))}" aria-hidden="true"></span>`;

  // ================= Prix =================
  function mkt(id) {
    if (overrides[id] != null) return overrides[id];
    const p = PR.prices[id];
    return p ? p[0] : null;
  }
  function npcPrice(id) {
    if (!$("optNpc").checked) return null;
    const o = CAT.npc[id]; if (!o) return null;
    const c = [o[faction], o.all].filter(v => v != null);
    return c.length ? Math.min(...c) : null;
  }

  // ================= Moteur =================
  // Un combo qui donne le même objet (souvent en plus grande quantité) augmente juste le rendement moyen.
  const selfCombo = r => r[11] && r[11][2] > 0 && GROUP_OF.get(r[11][0]) === GROUP_OF.get(r[1]);
  const yieldOf = r => selfCombo(r) && $("optCombo").checked ? (1 - r[11][2] / 10000) * r[2] + (r[11][2] / 10000) * r[11][1] : r[2];
  // Coût minimal de chaque objet : achat (HV ou PNJ), craft, ou combo depuis une recette parente.
  function solve(ownedIds) {
    const useCombo = $("optCombo").checked, useResale = $("optResale").checked;
    const cost = new Map(), how = new Map();
    const c = id => { const v = cost.get(id); return v == null ? Infinity : v; };
    for (const id of Object.keys(CAT.items)) {
      const m = mkt(id), n = npcPrice(id);
      if (n != null && (m == null || n <= m)) { cost.set(Number(id), n); how.set(Number(id), { t: "npc" }); }
      else if (m != null) { cost.set(Number(id), m); how.set(Number(id), { t: "buy" }); }
    }
    for (const id of ownedIds) { cost.set(id, 0); how.set(id, { t: "owned" }); }
    const inputsCost = r => {
      let total = r[12] || 0;
      for (const [id, q, alts] of r[9]) {
        let best = c(id) * q;
        for (const [a, qa] of alts) best = Math.min(best, c(a) * qa);
        if (!isFinite(best)) return Infinity;
        total += best;
      }
      if (r[10].length) {
        let m = Infinity; for (const a of r[10]) m = Math.min(m, c(a));
        if (!isFinite(m)) return Infinity;
        total += m;
      }
      return total;
    };
    for (let pass = 0; pass < 60; pass++) {
      let changed = false;
      for (const r of RECIPES) {
        const total = inputsCost(r);
        if (!isFinite(total)) continue;
        const unit = total / yieldOf(r);
        if (unit < c(r[1]) - 0.01 && !ownedIds.has(r[1])) { cost.set(r[1], unit); how.set(r[1], { t: "craft", r }); changed = true; }
        if (useCombo && r[11] && r[11][2] > 0 && !selfCombo(r)) {
          const p = r[11][2] / 10000, tries = 1 / p;
          const sell = useResale ? (mkt(r[1]) || 0) * (1 - TAX) * r[2] : 0;
          const exp = Math.max(0, tries * total - (tries - 1) * sell) / r[11][1];
          if (exp < c(r[11][0]) - 0.01 && !ownedIds.has(r[11][0])) { cost.set(r[11][0], exp); how.set(r[11][0], { t: "combo", r }); changed = true; }
        }
      }
      if (!changed) break;
    }
    return { cost, how, c, inputsCost };
  }

  // Meilleure façon de fabriquer (sans l'acheter) un objet du groupe visé.
  function bestCraft(S, ids) {
    const useCombo = $("optCombo").checked, useResale = $("optResale").checked;
    let best = null;
    for (const id of ids) {
      for (const r of BY_OUT.get(id) || []) {
        const total = S.inputsCost(r); if (!isFinite(total)) continue;
        const unit = total / yieldOf(r);
        if (!best || unit < best.unit) best = { id, unit, how: { t: "craft", r } };
      }
      if (useCombo) for (const r of BY_COMBO.get(id) || []) {
        if (selfCombo(r)) continue;
        const total = S.inputsCost(r); if (!isFinite(total)) continue;
        const p = r[11][2] / 10000, tries = 1 / p;
        const sell = useResale ? (mkt(r[1]) || 0) * (1 - TAX) * r[2] : 0;
        const unit = Math.max(0, tries * total - (tries - 1) * sell) / r[11][1];
        if (!best || unit < best.unit) best = { id, unit, how: { t: "combo", r } };
      }
    }
    return best;
  }

  // Développe l'arbre de fabrication d'un objet.
  function expand(S, id, qty, stack, forced, ownedLeft) {
    const h = forced || S.how.get(id);
    const node = { id, qty, t: h ? h.t : "missing", total: 0, kids: [], notes: [] };
    if (!h || (!forced && !isFinite(S.c(id)))) { node.t = "missing"; node.total = NaN; return node; }
    if (h.t === "owned") {
      const left = ownedLeft.get(id) || 0;
      if (left >= qty) { ownedLeft.set(id, left - qty); return node; }
      // On ne possède qu'un exemplaire : le reste s'achète.
      ownedLeft.set(id, 0);
      const extra = qty - left;
      const m = mkt(id);
      node.qty = left; node.t = "owned";
      const more = { id, qty: extra, t: m == null ? "missing" : "buy", total: m == null ? NaN : m * extra, kids: [], notes: [] };
      return { id, qty, t: "group", total: more.total, kids: [node, more], notes: [] };
    }
    if (h.t === "buy" || h.t === "npc") { node.total = S.c(id) * qty; node.unit = S.c(id); return node; }
    if (stack.has(id)) { node.t = "missing"; node.total = NaN; return node; }
    stack.add(id);
    const r = h.r;
    let runs, made;
    if (h.t === "craft") { runs = Math.ceil(qty / yieldOf(r) - 1e-9); made = runs * r[2]; node.runs = runs; }
    else {
      const p = r[11][2] / 10000, tries = 1 / p;
      runs = qty / r[11][1] * tries; node.runs = runs; node.p = p;
      if ($("optResale").checked && mkt(r[1]) != null) {
        const extra = (runs - qty / r[11][1]) * r[2];
        node.credit = { id: r[1], qty: extra, total: -extra * mkt(r[1]) * (1 - TAX) };
      }
    }
    node.r = r;
    for (const [iid, q, alts] of r[9]) {
      let pick = iid, pq = q, best = S.c(iid) * q;
      for (const [a, qa] of alts) if (S.c(a) * qa < best) { best = S.c(a) * qa; pick = a; pq = qa; }
      node.kids.push(expand(S, pick, pq * runs, stack, null, ownedLeft));
    }
    if (r[10].length) {
      let pick = r[10][0];
      for (const a of r[10]) if (S.c(a) < S.c(pick)) pick = a;
      const k = expand(S, pick, runs, stack, null, ownedLeft); k.transfer = true;
      node.kids.push(k);
    }
    if (r[12]) node.fee = r[12] * runs;
    stack.delete(id);
    node.total = node.kids.reduce((a, k) => a + k.total, 0) + (node.fee || 0) + (node.credit ? node.credit.total : 0);
    return node;
  }

  // ================= Données =================
  function buildIndex() {
    RECIPES = CAT.recipes.filter(r => !r[6] || r[6] === faction);
    BY_OUT = new Map(); BY_COMBO = new Map();
    for (const r of RECIPES) {
      if (!BY_OUT.has(r[1])) BY_OUT.set(r[1], []); BY_OUT.get(r[1]).push(r);
      if (r[11]) { if (!BY_COMBO.has(r[11][0])) BY_COMBO.set(r[11][0], []); BY_COMBO.get(r[11][0]).push(r); }
    }
    GROUPS = new Map(); GROUP_OF = new Map();
    const addTo = (id, main, sub) => {
      const [fr, en, grade] = item(id);
      const key = norm(fr) + "|" + grade;
      let g = GROUPS.get(key);
      if (!g) { g = { key, name: fr, en, grade, ids: [], main, sub, craftable: false }; GROUPS.set(key, g); }
      if (!g.ids.includes(id)) g.ids.push(id);
      if (!g.main && main) { g.main = main; g.sub = sub; }
      GROUP_OF.set(id, key);
      return g;
    };
    for (const id of Object.keys(CAT.items)) addTo(Number(id), "", "");
    for (const r of RECIPES) {
      addTo(r[1], r[7], r[8]).craftable = true;
      if (r[11]) addTo(r[11][0], r[7], r[8]).craftable = true;
      for (const [i, , alts] of r[9]) { addTo(i, "", ""); for (const [a] of alts) addTo(a, "", ""); }
      for (const a of r[10]) addTo(a, "", "");
    }
  }

  // Équipements en amont de l'objectif (pour la liste « J'ai déjà »).
  function upstreamGroups(goal) {
    const seen = new Map(); // clé → profondeur
    let frontier = [...goal.ids], depth = 0;
    const visitedIds = new Set(frontier);
    while (frontier.length && depth < 14) {
      depth++;
      const next = [];
      for (const id of frontier) {
        const rs = [...(BY_OUT.get(id) || []), ...(BY_COMBO.get(id) || [])];
        for (const r of rs) {
          const ins = [];
          for (const [i, , alts] of r[9]) { ins.push(i); for (const [a] of alts) ins.push(a); }
          ins.push(...r[10]);
          for (const i of ins) {
            if (visitedIds.has(i)) continue; visitedIds.add(i);
            const k = GROUP_OF.get(i);
            if (item(i)[3] === "Equip" && k && k !== goal.key && !seen.has(k)) seen.set(k, depth);
            next.push(i);
          }
        }
      }
      frontier = next;
    }
    return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => GROUPS.get(k));
  }

  // ================= Interface : objectif =================
  const goalInput = $("goal"), goalList = $("goal-list");
  let listItems = [], activeIdx = -1;
  function catOf(g) { for (const [k, , mains] of CATS) if (mains && mains.includes(g.main)) return k; return "misc"; }
  function renderCats() {
    $("cats").innerHTML = CATS.map(([k, label]) => `<button type="button" data-cat="${k}" aria-pressed="${k === catFilter}">${label}</button>`).join("");
  }
  $("cats").addEventListener("click", e => {
    const b = e.target.closest("button[data-cat]"); if (!b) return;
    catFilter = b.dataset.cat; renderCats(); openList(); goalInput.focus();
  });
  function searchGroups(q, onlyCraftable, limit) {
    const n = norm(q).trim();
    const words = n.split(/\s+/).filter(Boolean);
    const out = [];
    for (const g of GROUPS.values()) {
      if (onlyCraftable && !g.craftable) continue;
      if (onlyCraftable && catFilter !== "all" && catOf(g) !== catFilter) continue;
      const hay = norm(g.name) + " " + norm(g.en);
      if (words.every(w => hay.includes(w))) out.push(g);
    }
    out.sort((a, b) => {
      const as = norm(a.name).startsWith(n) ? 0 : 1, bs = norm(b.name).startsWith(n) ? 0 : 1;
      return as - bs || (GRADE_RANK[b.grade] || 0) - (GRADE_RANK[a.grade] || 0) || a.name.localeCompare(b.name, "fr");
    });
    return limit ? out.slice(0, limit) : out;
  }
  function openList() {
    listItems = searchGroups(goalInput.value, true, 60);
    activeIdx = listItems.length ? 0 : -1;
    goalList.innerHTML = listItems.length
      ? listItems.map((g, i) => `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === activeIdx}"><span>${gdot(g.ids[0])}${esc(g.name)}</span><span class="sub">${esc(g.sub || g.main || "")}</span></li>`).join("")
      : `<li class="none">Aucun objet fabricable ne correspond.</li>`;
    goalList.hidden = false; goalInput.setAttribute("aria-expanded", "true");
  }
  function closeList() { goalList.hidden = true; goalInput.setAttribute("aria-expanded", "false"); }
  function pickGoal(g) {
    goalKey = g.key; goalInput.value = g.name; closeList();
    haveKey = ""; fillHave(); compute();
  }
  goalInput.addEventListener("input", openList);
  goalInput.addEventListener("focus", () => { goalInput.select(); openList(); });
  goalInput.addEventListener("keydown", e => {
    if (goalList.hidden && (e.key === "ArrowDown" || e.key === "Enter")) { openList(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); if (!listItems.length) return;
      activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + listItems.length) % listItems.length;
      goalList.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === activeIdx)));
      const li = $("opt-" + activeIdx); if (li) li.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); if (listItems[activeIdx]) pickGoal(listItems[activeIdx]); }
    else if (e.key === "Escape") { closeList(); }
  });
  goalList.addEventListener("mousedown", e => { const li = e.target.closest("li[data-i]"); if (li) { e.preventDefault(); pickGoal(listItems[Number(li.dataset.i)]); } });
  document.addEventListener("click", e => { if (!$("goal-combo").contains(e.target)) { closeList(); if (goalKey && GROUPS.get(goalKey)) goalInput.value = GROUPS.get(goalKey).name; } });

  function fillHave() {
    const sel = $("have");
    const g = GROUPS.get(goalKey);
    const ups = g ? upstreamGroups(g) : [];
    sel.innerHTML = `<option value="">Rien</option>` + ups.map(u => `<option value="${esc(u.key)}">${esc(u.name)}</option>`).join("");
    sel.value = ups.some(u => u.key === haveKey) ? haveKey : "";
    haveKey = sel.value;
  }
  $("have").addEventListener("change", () => { haveKey = $("have").value; compute(); });
  $("qty").addEventListener("change", () => { const v = Math.max(1, Math.min(999, Math.round(Number($("qty").value) || 1))); $("qty").value = v; compute(); });
  for (const id of ["optCombo", "optResale", "optNpc"]) $(id).addEventListener("change", () => { save("atelier-opts", { combo: $("optCombo").checked, resale: $("optResale").checked, npc: $("optNpc").checked }); compute(); });

  // ================= Calcul et affichage =================
  function srcTag(n) {
    if (n.t === "npc") return `<span class="tag npc">PNJ</span>`;
    if (n.t === "craft" || n.t === "combo") return `<span class="tag craft">fabriqué ↑</span>`;
    if (n.t === "owned") return `<span class="tag">déjà possédé</span>`;
    if (n.transfer) return `<span class="tag">transfert</span>`;
    return "";
  }
  function row(n) {
    const cls = n.t === "missing" ? "missing" : n.t === "owned" ? "owned" : "";
    const unit = n.t === "buy" || n.t === "npc" ? `<span class="muted small"> à ${kinah(n.unit)}</span>` : "";
    const val = n.t === "missing" ? "prix manquant" : n.t === "owned" ? "possédé" : kinah(n.total);
    return `<tr class="${cls}"><td class="q">×${qtyFmt(n.qty)}</td><td>${gdot(n.id)}${esc(nameOf(n.id))}${unit}${srcTag(n)}<span class="en">${esc(enOf(n.id))}${n.transfer ? " · équipement transféré, consommé" : ""}</span></td><td class="v">${val}</td></tr>`;
  }
  const isMade = k => k.t === "craft" || k.t === "combo";
  // Ordre de fabrication (les sous-crafts d'abord), en regroupant les crafts identiques.
  function flat(n, out, seen = new Map()) {
    if (n.t === "group") { n.kids.forEach(k => flat(k, out, seen)); return; }
    if (!isMade(n)) return;
    n.kids.forEach(k => flat(k, out, seen));
    // Coût propre de l'étape : ce qui est acheté ici (les objets fabriqués sont comptés dans leur étape).
    const own = n.total - n.kids.filter(isMade).reduce((a, k) => a + k.total, 0);
    const key = n.id + "|" + n.t + "|" + n.r[0];
    const prev = seen.get(key);
    if (!prev) {
      const s = { ...n, own, kids: n.kids.map(k => ({ ...k })), credit: n.credit ? { ...n.credit } : null };
      seen.set(key, s); out.push(s); return;
    }
    prev.qty += n.qty; prev.runs += n.runs; prev.total += n.total; prev.own += own;
    if (n.fee) prev.fee = (prev.fee || 0) + n.fee;
    if (n.credit) { if (prev.credit) { prev.credit.qty += n.credit.qty; prev.credit.total += n.credit.total; } else prev.credit = { ...n.credit }; }
    for (const k of n.kids) {
      const m = prev.kids.find(x => x.id === k.id && x.t === k.t);
      if (m) { m.qty += k.qty; m.total += k.total; } else prev.kids.push({ ...k });
    }
  }
  function leaves(n, acc) {
    if (n.t === "group") { n.kids.forEach(k => leaves(k, acc)); return; }
    if (n.t === "craft" || n.t === "combo") { n.kids.forEach(k => leaves(k, acc)); if (n.credit) acc.credit += -n.credit.total; if (n.fee) acc.fee += n.fee; return; }
    const key = n.t + ":" + n.id;
    const a = acc.map.get(key) || { id: n.id, t: n.t, qty: 0, total: 0, unit: n.unit };
    a.qty += n.qty; a.total += n.t === "missing" ? 0 : n.total; acc.map.set(key, a);
  }

  function compute() {
    writeUrl();
    const out = $("out");
    const g = GROUPS.get(goalKey);
    if (!CAT || !g) { out.innerHTML = `<div class="empty">Choisis un objectif pour voir ce qu'il te coûte.</div>`; return; }
    const qty = Math.max(1, Math.round(Number($("qty").value) || 1));
    const owned = new Set(haveKey && GROUPS.get(haveKey) ? GROUPS.get(haveKey).ids : []);
    const S = solve(owned);
    const craft = bestCraft(S, g.ids);
    let buy = null; for (const id of g.ids) { const m = mkt(id); if (m != null && (!buy || m < buy.p)) buy = { id, p: m, n: PR.prices[id] ? PR.prices[id][1] : null }; }

    const head = `<div class="goal-name">${gdot(g.ids[0])}${esc(g.name)}${qty > 1 ? " ×" + qty : ""}</div>`;
    if (!craft) {
      out.innerHTML = `<div class="result"><div>${head}<div class="label">Coût de fabrication</div><div class="total">Impossible</div>
        <div class="muted small">Il manque le prix d'au moins un matériau sur ce serveur, ou l'objet ne se fabrique pas pour ta faction. Tu peux entrer un prix à la main dans l'onglet « Prix du marché ».</div></div>
        <div class="side">${buy ? `<span class="label">Achat direct</span><span class="num">${kinah(buy.p * qty)}</span>` : ""}</div></div>` + missingList(S, g);
      return;
    }
    const owned1 = new Map([...owned].map(id => [id, 1]));
    const root = expand(S, craft.id, qty, new Set(), craft.how, owned1);
    const complete = isFinite(root.total);
    const steps = []; flat(root, steps);
    const acc = { map: new Map(), credit: 0, fee: 0 }; leaves(root, acc);
    const usedOwned = [...acc.map.values()].some(l => l.t === "owned");
    const total = root.total;
    let side = "";
    if (buy) {
      const b = buy.p * qty;
      const verdict = complete && b < total ? `<span class="chip warn">Moins cher à l'achat</span>` : complete ? `<span class="chip good">Moins cher à fabriquer</span>` : "";
      side = `<span class="label">Achat direct à l'HV</span><span class="num">${kinah(b)}</span><span class="muted small">${buy.n != null ? buy.n + " annonce" + (buy.n > 1 ? "s" : "") : ""}</span>${verdict}`;
    } else side = `<span class="label">Achat direct</span><span class="muted small">Pas en vente sur ce serveur</span>`;
    let html = `<div class="result"><div>${head}<div class="label">Coût de fabrication${haveKey ? " depuis « " + esc(GROUPS.get(haveKey).name) + " »" : ""}</div>
      <div class="total">${complete ? kinah(total) : "Incomplet"}${complete ? "<small>Kinah</small>" : ""}</div>
      <div class="muted small num">${complete ? full(total) + " Kinah" : "Il manque des prix : voir les lignes en rouge."}</div></div>
      <div class="side">${side}</div></div>`;
    if (haveKey && !usedOwned) html += `<p class="notice info">Le calcul n'utilise pas ton « ${esc(GROUPS.get(haveKey).name)} » : il est moins cher de partir d'un autre chemin.</p>`;
    if (steps.some(s => s.t === "combo")) html += `<p class="notice info">Les étapes « combo » sont des moyennes : l'objet éclatant sort une fois sur ${Math.round(1 / steps.find(s => s.t === "combo").p)} en moyenne. Tu peux avoir plus ou moins de chance.</p>`;

    html += `<div class="section-title"><h2>Étapes</h2><span class="muted small">${steps.length} étape${steps.length > 1 ? "s" : ""}, dans l'ordre · montant = achats de l'étape</span></div><div class="steps">`;
    html += steps.map((s, i) => {
      const r = s.r;
      const kind = s.t === "combo" ? `Combo (${Math.round(s.p * 100)} %) sur « ${esc(nameOf(r[1]))} »` : r[10].length ? "Transfert" : r[3] ? "Conversion" : "Craft";
      const runs = s.t === "combo" ? `≈ ${qtyFmt(s.runs)} essais` : `${qtyFmt(s.runs)} craft${s.runs > 1 ? "s" : ""}`;
      const isEquip = item(s.id)[3] === "Equip";
      const notes = [];
      if (r[10].length) notes.push("L'équipement précédent est consommé ; son enchantement est conservé. L'objet obtenu est lié au personnage.");
      if (s.t === "combo" && s.credit) notes.push(`Les ${qtyFmt(s.credit.qty)} « ${nameOf(s.credit.id)} » obtenus en ratant le combo sont revendus (taxe de 12 % déduite).`);
      if (r[11] && s.t === "craft" && selfCombo(r)) notes.push(`Combo (${Math.round(r[11][2] / 100)} %) : donne ${r[11][1]} au lieu de ${r[2]}. Compté en moyenne : ${nf2.format(yieldOf(r))} par craft.`);
      else if (r[11] && s.t === "craft") notes.push(`Combo possible (${Math.round(r[11][2] / 100)} %) : donne « ${nameOf(r[11][0])} » à la place.`);
      return `<article class="step${isEquip ? "" : " sub"}">
        <div class="step-head"><div class="step-title"><span class="label">Étape ${i + 1}</span><h3>${gdot(s.id)}${esc(nameOf(s.id))}${s.qty !== 1 ? " ×" + qtyFmt(s.qty) : ""}</h3><span class="chip">${kind}</span><span class="muted small">${runs} · ${esc(PROF[r[4]] || r[4])}${r[5] ? " · maîtrise " + r[5] : ""}</span></div>
        <span class="step-cost" title="Achats de cette étape ; les objets fabriqués sont comptés dans leur propre étape">${!isFinite(s.own) ? "—" : s.own < 0 ? `<span style="color:var(--good)">+ ${kinah(-s.own)} net</span>` : kinah(s.own)}</span></div>
        <div class="step-body"><div class="table-wrap"><table class="lines">${s.kids.map(k => k.t === "group" ? k.kids.map(row).join("") : row(k)).join("")}
        ${s.credit ? `<tr class="credit"><td class="q">×${qtyFmt(s.credit.qty)}</td><td>${esc(nameOf(s.credit.id))}<span class="en">revente des objets normaux</span></td><td class="v">− ${kinah(-s.credit.total)}</td></tr>` : ""}
        ${s.fee ? `<tr><td class="q"></td><td>Frais de fabrication</td><td class="v">${kinah(s.fee)}</td></tr>` : ""}
        </table></div>${notes.map(t => `<p class="step-note">${esc(t)}</p>`).join("")}</div></article>`;
    }).join("") + `</div>`;

    const rows = [...acc.map.values()].filter(l => l.t !== "owned").sort((a, b) => (a.t === "missing") - (b.t === "missing") || b.total - a.total);
    html += `<div class="shop"><div class="section-title"><h2>À acheter</h2><span class="muted small">du plus cher au moins cher</span></div>
      <div class="table-wrap"><table class="lines">${rows.map(l => row({ id: l.id, qty: l.qty, t: l.t, total: l.total, unit: l.unit })).join("")}
      ${acc.credit > 0 ? `<tr class="credit"><td class="q"></td><td>Reventes des objets normaux<span class="en">taxe de 12 % déduite</span></td><td class="v">− ${kinah(acc.credit)}</td></tr>` : ""}
      </table></div></div>`;
    out.innerHTML = html;
  }
  function missingList(S, g) {
    const miss = new Set();
    for (const id of g.ids) for (const r of [...(BY_OUT.get(id) || []), ...(BY_COMBO.get(id) || [])]) {
      for (const [i, , alts] of r[9]) if (!isFinite(S.c(i)) && alts.every(([a]) => !isFinite(S.c(a)))) miss.add(i);
      if (r[10].length && r[10].every(a => !isFinite(S.c(a)))) miss.add(r[10][0]);
    }
    if (!miss.size) return "";
    return `<p class="notice">Sans prix ni recette disponible : ${[...miss].map(i => esc(nameOf(i))).join(", ")}.</p>`;
  }

  // ================= Onglet prix =================
  function renderPrices() {
    const q = $("psearch").value;
    const S = solve(new Set());
    let gs = searchGroups(q, false, 0).filter(g => g.ids.some(id => PR.prices[id] || overrides[id] != null || CAT.npc[id] || g.craftable));
    const total = gs.length; gs = gs.slice(0, 80);
    let html = `<thead><tr><th>Objet</th><th class="r">Prix HV (Kinah)</th><th class="r">Annonces</th><th class="r">Coût de fabrication</th></tr></thead><tbody>`;
    for (const g of gs) {
      const id = g.ids.find(i => PR.prices[i] || overrides[i] != null) || g.ids[0];
      const p = PR.prices[id];
      const v = overrides[id] != null ? overrides[id] : p ? p[0] : "";
      const bc = g.craftable ? bestCraft(S, g.ids) : null;
      const npc = CAT.npc[id] && npcPrice(id) != null ? ` · PNJ ${kinah(npcPrice(id))}` : "";
      html += `<tr><td>${gdot(id)}${esc(g.name)}<span class="en">${esc(g.en)}${npc}</span></td>
        <td class="r"><input id="p-${id}" data-id="${id}" inputmode="numeric" value="${v}" placeholder="aucune annonce" class="${overrides[id] != null ? "edited" : ""}" aria-label="Prix de ${esc(g.name)}"></td>
        <td class="r num muted">${p && p[1] != null ? p[1] : "—"}</td>
        <td class="r">${bc ? `<span class="num">${kinah(bc.unit)}</span><br><button class="linkish" type="button" data-goal="${esc(g.key)}">Détail</button>` : `<span class="muted">—</span>`}</td></tr>`;
    }
    if (!gs.length) html += `<tr><td colspan="4" class="muted">Aucun objet ne correspond.</td></tr>`;
    else if (total > gs.length) html += `<tr><td colspan="4" class="muted small">${total - gs.length} autres résultats : précise ta recherche.</td></tr>`;
    $("ptable").innerHTML = html + "</tbody>";
  }
  let pTimer = 0;
  $("psearch").addEventListener("input", () => { clearTimeout(pTimer); pTimer = setTimeout(renderPrices, 150); });
  $("ptable").addEventListener("change", e => {
    const inp = e.target.closest("input[data-id]"); if (!inp) return;
    const id = inp.dataset.id, raw = inp.value.replace(/[^\d]/g, "");
    const orig = PR.prices[id] ? String(PR.prices[id][0]) : "";
    if (raw === "" || raw === orig) delete overrides[id]; else overrides[id] = Number(raw);
    save("atelier-overrides", overrides); inp.classList.toggle("edited", overrides[id] != null);
  });
  $("ptable").addEventListener("click", e => {
    const b = e.target.closest("button[data-goal]"); if (!b) return;
    const g = GROUPS.get(b.dataset.goal); if (!g) return;
    showTab("tab-calc"); pickGoal(g);
  });
  $("resetEdits").addEventListener("click", () => { overrides = {}; save("atelier-overrides", overrides); renderPrices(); });

  function showTab(tab) {
    for (const [t, v] of [["tab-calc", "view-calc"], ["tab-prix", "view-prix"]]) { $(t).setAttribute("aria-selected", String(t === tab)); $(v).hidden = t !== tab; }
    if (tab === "tab-prix") renderPrices(); else compute();
  }
  $("tab-calc").addEventListener("click", () => showTab("tab-calc"));
  $("tab-prix").addEventListener("click", () => showTab("tab-prix"));

  // ================= Serveur et adresse =================
  function writeUrl() {
    const p = new URLSearchParams();
    if (server) p.set("s", server.id);
    const g = GROUPS.get(goalKey); if (g) p.set("goal", g.ids[0]);
    const h = GROUPS.get(haveKey); if (h) p.set("have", h.ids[0]);
    const q = Number($("qty").value); if (q > 1) p.set("q", q);
    history.replaceState(null, "", "?" + p.toString());
  }
  function setFreshness() {
    const el = $("freshness");
    if (!PR.asOf) { el.textContent = "Pas de prix pour ce serveur"; el.className = "chip warn"; return; }
    const d = new Date(PR.asOf);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    el.textContent = "Prix relevés " + (mins < 1 ? "à l'instant" : mins < 90 ? "il y a " + mins + " min" : "le " + d.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
    el.className = "chip " + (mins > 60 ? "warn" : "ghost");
  }
  async function loadServer(id) {
    server = SERVERS.find(s => s.id === id) || SERVERS.find(s => s.id === DEFAULT_SERVER) || SERVERS[0];
    faction = server.faction;
    save("atelier-server", server.id);
    $("server").value = server.id;
    try {
      const res = await fetch("data/prices/" + server.id + ".json", { cache: "no-cache" });
      PR = res.ok ? await res.json() : { prices: {}, asOf: null };
    } catch (e) { PR = { prices: {}, asOf: null }; }
    buildIndex(); setFreshness();
    if (goalKey && !GROUPS.get(goalKey)) goalKey = null;
    fillHave();
    if (!$("view-prix").hidden) renderPrices(); else compute();
  }
  $("server").addEventListener("change", () => loadServer($("server").value));

  async function boot() {
    const o = load("atelier-opts", null);
    if (o) { $("optCombo").checked = o.combo !== false; $("optResale").checked = o.resale !== false; $("optNpc").checked = o.npc !== false; }
    renderCats();
    try {
      const [cat, srv] = await Promise.all([fetch("data/catalog.json", { cache: "no-cache" }).then(r => r.json()), fetch("data/servers.json", { cache: "no-cache" }).then(r => r.json())]);
      CAT = cat; SERVERS = srv.servers;
    } catch (e) {
      $("out").innerHTML = `<p class="notice">Les données n'ont pas pu être chargées. Recharge la page dans un instant.</p>`; return;
    }
    const FAC = { asmodian: "Asmodiens", elyos: "Élyséens" };
    const regions = [...new Set(SERVERS.map(s => s.regionName))];
    $("server").innerHTML = regions.map(rn => `<optgroup label="${esc(rn)}">${SERVERS.filter(s => s.regionName === rn).map(s => `<option value="${s.id}">${esc(s.name)} · ${FAC[s.faction]}</option>`).join("")}</optgroup>`).join("");
    const url = new URLSearchParams(location.search);
    const sid = url.get("s") || load("atelier-server", DEFAULT_SERVER);
    if (url.get("q")) $("qty").value = Math.max(1, Math.min(999, Number(url.get("q")) || 1));
    server = SERVERS.find(s => s.id === sid) || SERVERS.find(s => s.id === DEFAULT_SERVER) || SERVERS[0];
    faction = server.faction; buildIndex();
    const gid = Number(url.get("goal")), hid = Number(url.get("have"));
    if (gid && GROUP_OF.get(gid)) { goalKey = GROUP_OF.get(gid); goalInput.value = GROUPS.get(goalKey).name; }
    if (hid && GROUP_OF.get(hid)) haveKey = GROUP_OF.get(hid);
    await loadServer(server.id);
    setInterval(setFreshness, 60000);
  }
  boot();
})();
