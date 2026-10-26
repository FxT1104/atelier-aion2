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
  const SUB = { Ring: "Anneau", Earring: "Boucles d'oreilles", Earrings: "Boucles d'oreilles", Necklace: "Collier", Bracelet: "Bracelet", Greatsword: "Espadon", Sword: "Épée", Longsword: "Épée", Dagger: "Dague", Bow: "Arc", Staff: "Bâton", Mace: "Masse", Orb: "Orbe", Magicbook: "Grimoire", Spellbook: "Grimoire", Guarder: "Garde", Guard: "Garde", Helmet: "Casque", Torso: "Plastron", Pants: "Jambières", Boots: "Bottes", Gloves: "Gants", Shoulder: "Épaulières", Cape: "Cape", Belt: "Ceinture", Wing: "Ailes", Potion: "Potion", Food: "Nourriture", Scroll: "Parchemin" };
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
  const lvlOf = id => item(id)[6] || 0;
  const lvlTag = l => l ? `<span class="tag lvl">niv. ${l}</span>` : "";
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
  function solve(ownedIds, o = {}) {
    const useCombo = $("optCombo").checked, useResale = o.resale != null ? o.resale : $("optResale").checked;
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
      if (!g) { g = { key, name: fr, en, grade, ids: [], main, sub, craftable: false, lvl: 0, kind: item(id)[4] }; GROUPS.set(key, g); }
      if (!g.ids.includes(id)) { g.ids.push(id); g.lvl = Math.max(g.lvl, lvlOf(id)); }
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
    // Du plus haut niveau au plus bas (à niveau égal, l'étape la plus proche de l'objectif d'abord).
    return [...seen.entries()].map(([k, d]) => ({ g: GROUPS.get(k), d })).sort((a, b) => b.g.lvl - a.g.lvl || a.d - b.d).map(x => x.g);
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
    catFilter = b.dataset.cat;
    // On met juste à jour les boutons (les recréer ferait croire à un clic en dehors de la recherche).
    $("cats").querySelectorAll("button[data-cat]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.cat === catFilter)));
    goalInput.value = ""; openList(); goalInput.focus();
  });
  function searchGroups(q, onlyCraftable, limit) {
    const n = norm(q).trim();
    const words = n.split(/\s+/).filter(Boolean);
    const out = [];
    for (const g of GROUPS.values()) {
      if (onlyCraftable && !g.craftable) continue;
      if (onlyCraftable && catFilter !== "all" && catOf(g) !== catFilter) continue;
      const hay = norm(g.name) + " " + norm(g.en) + (g.lvl ? " " + g.lvl : "");
      if (words.every(w => hay.includes(w))) out.push(g);
    }
    out.sort((a, b) => {
      const as = norm(a.name).startsWith(n) ? 0 : 1, bs = norm(b.name).startsWith(n) ? 0 : 1;
      return as - bs || b.lvl - a.lvl || (GRADE_RANK[b.grade] || 0) - (GRADE_RANK[a.grade] || 0) || a.name.localeCompare(b.name, "fr");
    });
    return limit ? out.slice(0, limit) : out;
  }
  function openList() {
    listItems = searchGroups(goalInput.value, true, 60);
    activeIdx = listItems.length ? 0 : -1;
    goalList.innerHTML = listItems.length
      ? listItems.map((g, i) => `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === activeIdx}"><span>${gdot(g.ids[0])}${esc(g.name)}</span><span class="lv">${g.lvl ? "niv. " + g.lvl : ""}</span><span class="sub">${esc(SUB[g.kind] || SUB[g.sub] || g.sub || g.main || "")}</span></li>`).join("")
      : `<li class="none">Aucun objet fabricable ne correspond.</li>`;
    goalList.hidden = false; goalInput.setAttribute("aria-expanded", "true");
  }
  function closeList() { goalList.hidden = true; goalInput.setAttribute("aria-expanded", "false"); }
  function pickGoal(g) {
    goalKey = g.key; goalInput.value = g.name; closeList();
    haveKey = ""; fillHave(); compute();
  }
  goalInput.addEventListener("input", openList);
  // En revenant sur la case, on repart d'une recherche vide pour voir toute la liste.
  const clearIfChosen = () => { const g = GROUPS.get(goalKey); if (g && goalInput.value === g.name) goalInput.value = ""; };
  goalInput.addEventListener("focus", () => { clearIfChosen(); openList(); });
  goalInput.addEventListener("click", () => { if (goalList.hidden) { clearIfChosen(); openList(); } });
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
  document.addEventListener("click", e => { if (e.target.isConnected && !$("goal-combo").contains(e.target) && !$("cats").contains(e.target)) { closeList(); if (goalKey && GROUPS.get(goalKey)) goalInput.value = GROUPS.get(goalKey).name; } });

  function fillHave() {
    const sel = $("have");
    const g = GROUPS.get(goalKey);
    const ups = g ? upstreamGroups(g) : [];
    sel.innerHTML = `<option value="">Rien</option>` + ups.map(u => `<option value="${esc(u.key)}">${esc(u.name)}${u.lvl ? " (niv. " + u.lvl + ")" : ""}</option>`).join("");
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

    const head = `<div class="goal-name">${gdot(g.ids[0])}${esc(g.name)}${qty > 1 ? " ×" + qty : ""}${lvlTag(g.lvl)}</div>`;
    if (!craft) {
      out.innerHTML = `<div class="result"><div>${head}<div class="label">Coût de fabrication</div><div class="total">Impossible</div>
        <div class="muted small">Il manque le prix d'au moins un matériau sur ce serveur, ou l'objet ne se fabrique pas pour ta faction. Tu peux entrer un prix à la main dans l'onglet « Prix du marché ».</div></div>
        <div class="side">${buy ? `<span class="label">Achat direct</span><span class="num">${kinah(buy.p * qty)}</span>` : ""}</div></div>` + chartSlot(g) + missingList(S, g);
      BASKET = { rows: [], credit: 0 };
      decorate(g);
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
    html += chartSlot(g);
    if (haveKey && !usedOwned) html += `<p class="notice info">Le calcul n'utilise pas ton « ${esc(GROUPS.get(haveKey).name)} » : il est moins cher de partir d'un autre chemin.</p>`;
    if (steps.some(s => s.t === "combo")) html += `<p class="notice info">Le coût compte les combos en moyenne : l'objet éclatant sort une fois sur ${Math.round(1 / steps.find(s => s.t === "combo").p)}. Tu peux avoir plus ou moins de chance.</p>`;


    // Liste de courses : tout ce qu'il faut acheter, regroupé par matériau.
    const rows = [...acc.map.values()].filter(l => l.t !== "owned").sort((a, b) => (a.t === "missing") - (b.t === "missing") || b.total - a.total);
    const ownedRows = [...acc.map.values()].filter(l => l.t === "owned");
    const fmtQ = q => Number.isInteger(q) ? nf.format(q) : "≈ " + nf.format(Math.ceil(q));
    html += `<div class="shop"><div class="section-title"><h2>Liste de courses</h2><button class="btn small-btn" id="copyList" type="button">Copier la liste</button></div>
      <p class="muted small">Tout ce qu'il faut acheter pour fabriquer « ${esc(g.name)} »${qty > 1 ? " ×" + qty : ""}${haveKey ? " en partant de ce que tu as" : ""}.</p>
      <div class="table-wrap"><table class="shoplist${PROXY ? "" : " no-trend"}"><thead><tr><th class="r">Quantité</th><th>Matériau</th><th class="r">Prix à l'unité</th><th class="r">Total</th><th class="r trend-h" title="Prix des 7 derniers jours et écart du prix actuel à sa moyenne">7 derniers jours</th></tr></thead><tbody>
      ${rows.map(l => `<tr class="${l.t === "missing" ? "missing" : ""}"><td class="r num qcol">${fmtQ(l.qty)}</td>
        <td>${gdot(l.id)}${esc(nameOf(l.id))}${l.t === "npc" ? `<span class="tag npc">marchand PNJ</span>` : ""}<span class="en">${esc(enOf(l.id))}</span></td>
        <td class="r num">${l.t === "missing" ? "—" : kinah(l.unit)}</td>
        <td class="r num">${l.t === "missing" ? "prix manquant" : kinah(l.total)}</td><td class="r trend" ${l.t === "buy" ? `data-trend="${l.id}"` : ""}></td></tr>`).join("")}
      ${ownedRows.map(l => `<tr class="owned"><td class="r num qcol">${fmtQ(l.qty)}</td><td>${gdot(l.id)}${esc(nameOf(l.id))}<span class="en">déjà possédé</span></td><td></td><td class="r">0</td><td class="trend"></td></tr>`).join("")}
      ${acc.credit > 0 ? `<tr class="credit"><td></td><td>Revente des objets normaux obtenus sans combo<span class="en">taxe de 12 % déduite</span></td><td></td><td class="r num">− ${kinah(acc.credit)}</td><td class="trend"></td></tr>` : ""}
      </tbody><tfoot><tr><td></td><td>Total</td><td></td><td class="r num">${complete ? kinah(total) : "incomplet"}</td><td class="trend"></td></tr></tfoot></table></div></div>`;
    BASKET = { rows: rows.filter(l => l.t !== "missing").map(l => ({ id: l.id, qty: l.qty, unit: l.unit, t: l.t })), credit: acc.credit };
    window.__shopText = [g.name + (qty > 1 ? " x" + qty : "") + " — " + (server ? server.name : ""), ...rows.map(l => fmtQ(l.qty) + " × " + nameOf(l.id) + (l.t === "missing" ? " (prix manquant)" : " = " + kinah(l.total))), "Total : " + (complete ? kinah(total) + " Kinah" : "incomplet")].join("\n");
    out.innerHTML = html;
    decorate(g);
  }
  $("out").addEventListener("click", async e => {
    const b = e.target.closest("#copyList"); if (!b) return;
    try { await navigator.clipboard.writeText(window.__shopText || ""); b.textContent = "Liste copiée"; }
    catch (err) { b.textContent = "Copie impossible"; }
    setTimeout(() => { b.textContent = "Copier la liste"; }, 2000);
  });
  function missingList(S, g) {
    const miss = new Set();
    for (const id of g.ids) for (const r of [...(BY_OUT.get(id) || []), ...(BY_COMBO.get(id) || [])]) {
      for (const [i, , alts] of r[9]) if (!isFinite(S.c(i)) && alts.every(([a]) => !isFinite(S.c(a)))) miss.add(i);
      if (r[10].length && r[10].every(a => !isFinite(S.c(a)))) miss.add(r[10][0]);
    }
    if (!miss.size) return "";
    return `<p class="notice">Sans prix ni recette disponible : ${[...miss].map(i => esc(nameOf(i))).join(", ")}.</p>`;
  }

  // ================= Historique des prix (relais Cloudflare) =================
  let PROXY = "", histDays = 7, decoSeq = 0, BASKET = { rows: [], credit: 0 };
  const HIST = new Map(); // "serveur|jours|id" → { obs } ou null
  const marketId = g => g.ids.find(id => PR.prices[id]) || null;
  function chartSlot(g) {
    if (!PROXY) return "";
    return `<div class="chart-card" id="chartCard"><div class="chart-head"><h2>Est-ce le bon moment ?</h2>
      <div class="seg" role="group" aria-label="Période">${[1, 7, 30].map(d => `<button type="button" data-days="${d}" aria-pressed="${d === histDays}">${d === 1 ? "24 h" : d + " j"}</button>`).join("")}</div></div>
      <div id="chartBody" class="chart-body"><p class="muted small">Chargement de l'historique…</p></div></div>`;
  }
  async function getHistory(ids, days) {
    const want = [...new Set(ids)].filter(id => !HIST.has(server.id + "|" + days + "|" + id));
    for (let i = 0; i < want.length; i += 30) {
      const chunk = want.slice(i, i + 30);
      try {
        const res = await fetch(`${PROXY}/history?server=${server.id}&days=${days}&items=${chunk.join(",")}`);
        const d = res.ok ? await res.json() : null;
        for (const id of chunk) {
          const h = d && d.items ? d.items[id] : null;
          if (h && h.obs) h.obs.sort((a, b) => a[0] - b[0]);
          HIST.set(server.id + "|" + days + "|" + id, h || null);
        }
      } catch (e) {
        for (const id of chunk) HIST.set(server.id + "|" + days + "|" + id, null);
      }
    }
    return Object.fromEntries(ids.map(id => [id, HIST.get(server.id + "|" + days + "|" + id)]));
  }
  function stats(values, current) {
    if (!values.length) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values), max = Math.max(...values);
    const cur = current != null ? current : values[values.length - 1];
    const below = values.filter(v => v < cur).length / values.length;
    return { avg, min, max, cur, diff: avg ? (cur - avg) / avg : 0, below, n: values.length };
  }
  // Prix d'un objet à l'instant t : dernier relevé connu (ou le premier si l'historique commence plus tard).
  function priceAt(obs, t, k) {
    while (k.i + 1 < obs.length && obs[k.i + 1][0] <= t) k.i++;
    return obs[k.i][1];
  }
  // Coût de la liste de courses au fil du temps : somme des matériaux × leur prix à chaque instant.
  function basketSeries(hist, days) {
    const now = Math.floor(Date.now() / 1000), N = 140;
    // On commence quand tous les matériaux suivis ont un prix connu, pour ne rien inventer.
    let t0 = now - days * 86400;
    for (const r of BASKET.rows) { const h = r.t === "buy" ? hist[r.id] : null; if (h && h.obs && h.obs.length) t0 = Math.max(t0, h.obs[0][0]); }
    const grid = Array.from({ length: N + 1 }, (_, i) => Math.round(t0 + (now - t0) * i / N));
    const vals = grid.map(() => -BASKET.credit);
    let tracked = 0;
    for (const r of BASKET.rows) {
      const h = r.t === "buy" ? hist[r.id] : null;
      if (h && h.obs && h.obs.length) {
        tracked++;
        const k = { i: 0 };
        grid.forEach((t, i) => { vals[i] += r.qty * priceAt(h.obs, t, k); });
      } else grid.forEach((t, i) => { vals[i] += r.qty * (r.unit || 0); });
    }
    return { pts: grid.map((t, i) => [t, vals[i]]), tracked };
  }
  function itemSeries(obs, days) {
    const now = Math.floor(Date.now() / 1000), t0 = Math.max(now - days * 86400, obs[0][0]), N = 140;
    const k = { i: 0 };
    return Array.from({ length: N + 1 }, (_, i) => { const t = Math.round(t0 + (now - t0) * i / N); return [t, priceAt(obs, t, k)]; });
  }
  function verdictOf(st) {
    return st.below <= 0.25 ? ["good", "bas"] : st.below >= 0.75 ? ["warn", "élevé"] : ["ghost", "normal"];
  }
  function diffText(st, period) {
    const pct = Math.round(st.diff * 100);
    return `${pct === 0 ? "égal à" : Math.abs(pct) + " % " + (pct < 0 ? "sous" : "au-dessus de")} sa moyenne sur ${period} (<span class="num">${kinah(st.avg)}</span>)`;
  }
  function spark(obs) {
    if (!obs || obs.length < 2) return "";
    const W = 64, H = 18, t0 = obs[0][0], t1 = Math.floor(Date.now() / 1000);
    const vs = obs.map(o => o[1]), lo = Math.min(...vs), hi = Math.max(...vs) || 1;
    const X = t => (t - t0) / Math.max(1, t1 - t0) * (W - 3);
    const Y = v => hi === lo ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4);
    let d = ""; obs.forEach((o, i) => { d += i ? `H${X(o[0]).toFixed(1)}V${Y(o[1]).toFixed(1)}` : `M0,${Y(o[1]).toFixed(1)}`; });
    d += `H${(W - 3).toFixed(1)}`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><path d="${d}"/><circle cx="${W - 3}" cy="${Y(vs[vs.length - 1]).toFixed(1)}" r="2"/></svg>`;
  }
  async function decorate(g) {
    if (!PROXY || !server) return;
    const seq = ++decoSeq;
    const days = histDays, period = days === 1 ? "24 h" : days + " jours";
    const mid = marketId(g);
    const buyIds = BASKET.rows.filter(r => r.t === "buy").map(r => r.id);
    const ids = mid ? [...buyIds, mid] : buyIds;
    const [h7, hd] = await Promise.all([getHistory(buyIds, 7), getHistory(ids, days)]);
    if (seq !== decoSeq) return;
    // Colonne de la liste de courses : mini-courbe 7 jours + écart à la moyenne
    for (const td of document.querySelectorAll("[data-trend]")) {
      const tid = Number(td.dataset.trend), h = h7[tid];
      const st = h && h.obs && h.obs.length > 2 ? stats(h.obs.map(o => o[1]), mkt(tid)) : null;
      if (!st) { td.innerHTML = `<span class="muted small">pas d'historique</span>`; continue; }
      const pct = Math.round(st.diff * 100);
      const cls = pct <= -5 ? "good" : pct >= 5 ? "warn" : "ghost";
      td.innerHTML = `<span class="trend-cell">${spark(h.obs)}<span class="chip ${cls}" title="Moyenne 7 j : ${kinah(st.avg)} · min ${kinah(st.min)} · max ${kinah(st.max)}">${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)} %</span></span>`;
    }
    const body = $("chartBody");
    if (!body) return;
    // Graphique global : coût de la liste de courses (et prix d'achat direct si l'objet est en vente)
    const series = [];
    let html = `<div class="chart-stats">`;
    const B = BASKET.rows.length ? basketSeries(hd, days) : null;
    if (B && B.tracked) {
      const st = stats(B.pts.map(p => p[1]), B.pts[B.pts.length - 1][1]);
      const v = verdictOf(st);
      series.push({ pts: B.pts, cls: "s-craft", label: "Fabriquer (liste de courses)" });
      html += `<span class="chip ${v[0]}">Liste de courses : prix ${v[1]}</span><span class="small">Aujourd'hui <b class="num">${kinah(st.cur)}</b>, ${diffText(st, period)}</span><span class="small muted">min <span class="num">${kinah(st.min)}</span> · max <span class="num">${kinah(st.max)}</span></span>`;
    }
    const hm = mid ? hd[mid] : null;
    if (hm && hm.obs && hm.obs.length > 1) {
      const pts = itemSeries(hm.obs, days);
      const st = stats(hm.obs.map(o => o[1]), mkt(mid));
      const v = verdictOf(st);
      series.push({ pts, cls: "s-buy", label: "Acheter l'objet fini à l'HV" });
      html += `<span class="break"></span><span class="chip ${v[0]}">Achat direct : prix ${v[1]}</span><span class="small">Aujourd'hui <b class="num">${kinah(st.cur)}</b>, ${diffText(st, period)}</span>`;
    }
    html += `</div>`;
    if (!series.length) { body.innerHTML = `<p class="muted small">Pas d'historique de prix pour les matériaux de cette recette sur ce serveur.</p>`; return; }
    const untracked = B ? BASKET.rows.length - B.tracked : 0;
    body.innerHTML = html + chartSvg(series, days) +
      `<div class="legend">${series.map(s => `<span><i class="${s.cls}"></i>${s.label}</span>`).join("")}</div>
      <p class="muted small">Coût total de ta liste de courses recalculé à chaque instant avec les prix demandés à l'hôtel des ventes${untracked ? ` (${untracked} objet${untracked > 1 ? "s" : ""} sans historique, comme les achats PNJ, compté${untracked > 1 ? "s" : ""} à prix fixe)` : ""}.</p>`;
  }
  function chartSvg(series, days) {
    const W = 640, H = 210, L = 64, R = 12, T = 12, B = 26;
    const all = series.flatMap(s => s.pts.map(p => p[1]));
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.12 || hi * 0.05 || 1;
    const y0 = Math.max(0, lo - pad), y1 = hi + pad;
    const t0 = Math.min(...series.map(s => s.pts[0][0])), t1 = Math.max(...series.map(s => s.pts[s.pts.length - 1][0]));
    const X = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R);
    const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const ticks = [y0 + (y1 - y0) * 0.1, (y0 + y1) / 2, y1 - (y1 - y0) * 0.1];
    let out = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="c-grid"/><text x="${L - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" class="c-lab">${kinah(v)}</text>`).join("");
    for (const s of series) {
      const d = s.pts.map((p, i) => (i ? "L" : "M") + X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join("");
      if (s.cls === "s-craft") out += `<path d="${d}L${X(t1).toFixed(1)},${H - B}L${X(t0).toFixed(1)},${H - B}Z" class="c-area"/>`;
      out += `<path d="${d}" class="c-line ${s.cls}"/>`;
      const last = s.pts[s.pts.length - 1];
      out += `<circle cx="${X(last[0]).toFixed(1)}" cy="${Y(last[1]).toFixed(1)}" r="4" class="c-dot ${s.cls}"/>`;
    }
    const fmtD = t => new Date(t * 1000).toLocaleString("fr-FR", days === 1 ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short" });
    out += `<text x="${L}" y="${H - 6}" class="c-lab">${fmtD(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end" class="c-lab">maintenant</text>`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du coût">${out}</svg>`;
  }
  $("out").addEventListener("click", e => {
    const b = e.target.closest(".seg button[data-days]"); if (!b) return;
    histDays = Number(b.dataset.days);
    b.parentElement.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    const g = GROUPS.get(goalKey); if (g) { $("chartBody").innerHTML = `<p class="muted small">Chargement de l'historique…</p>`; decorate(g); }
  });

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
      html += `<tr><td>${gdot(id)}${esc(g.name)}${lvlTag(g.lvl)}<span class="en">${esc(g.en)}${npc}</span></td>
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

  const TABS = [["tab-calc", "view-calc"], ["tab-rent", "view-rent"], ["tab-prix", "view-prix"]];
  function showTab(tab) {
    for (const [t, v] of TABS) { $(t).setAttribute("aria-selected", String(t === tab)); $(v).hidden = t !== tab; }
    if (tab === "tab-prix") renderPrices(); else if (tab === "tab-rent") renderProfit(); else compute();
  }
  function refreshView() { if (!$("view-prix").hidden) renderPrices(); else if (!$("view-rent").hidden) renderProfit(); else compute(); }
  for (const [t] of TABS) $(t).addEventListener("click", () => showTab(t));

  // ================= Onglet rentabilité =================
  let rentCat = "all";
  function renderRentCats() {
    $("rcats").innerHTML = CATS.map(([k, label]) => `<button type="button" data-cat="${k}" aria-pressed="${k === rentCat}">${label}</button>`).join("");
  }
  $("rcats").addEventListener("click", e => {
    const b = e.target.closest("button[data-cat]"); if (!b) return;
    rentCat = b.dataset.cat;
    $("rcats").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.cat === rentCat)));
    renderProfit();
  });
  // Rentabilité d'une recette : ce que rapporte un craft (vente de l'objet obtenu, combo compris en moyenne)
  // moins le coût des matériaux. Les matériaux sont comptés sans supposer de revente de sous-produits.
  function renderProfit() {
    if (!CAT) return;
    if (!$("rcats").innerHTML) renderRentCats();
    const S = solve(new Set(), { resale: false });
    const q = norm($("rsearch").value).trim().split(/\s+/).filter(Boolean);
    const minL = Number($("rmin").value) || 1, sort = $("rsort").value;
    const best = new Map();
    for (const r of RECIPES) {
      if (r[3]) continue; // conversions : pas de vente
      const out = r[1], price = mkt(out);
      if (price == null) continue;
      const g = GROUPS.get(GROUP_OF.get(out)); if (!g) continue;
      if (rentCat !== "all" && catOf(g) !== rentCat) continue;
      const listings = PR.prices[out] ? PR.prices[out][1] : null;
      if ((listings || 0) < minL) continue;
      if (q.length) { const hay = norm(g.name) + " " + norm(g.en) + " " + g.lvl; if (!q.every(w => hay.includes(w))) continue; }
      const cost = S.inputsCost(r); if (!isFinite(cost) || cost <= 0) continue;
      let revenue = price * (1 - TAX) * r[2], combo = null;
      if (r[11] && r[11][2] > 0 && $("optCombo").checked) {
        const p = r[11][2] / 10000, cp = mkt(r[11][0]);
        const cval = cp != null ? cp * (1 - TAX) * r[11][1] : price * (1 - TAX) * r[2];
        revenue = (1 - p) * revenue + p * cval;
        combo = { id: r[11][0], p, price: cp };
      }
      const profit = revenue - cost;
      const row = { g, id: out, price, revenue, cost, profit, margin: profit / cost, listings, combo, qty: r[2], prof: r[4], mastery: r[5] };
      const prev = best.get(g.key);
      if (!prev || row.profit > prev.profit) best.set(g.key, row);
    }
    const rows = [...best.values()];
    const key = { profit: r => r.profit, margin: r => r.margin, listings: r => r.listings || 0 }[sort];
    rows.sort((a, b) => key(b) - key(a));
    const good = rows.filter(r => r.profit > 0);
    const top = good.slice().sort((a, b) => b.profit - a.profit)[0];
    $("rsummary").innerHTML = rows.length
      ? `<p class="small"><b>${good.length}</b> craft${good.length > 1 ? "s" : ""} rentable${good.length > 1 ? "s" : ""} sur ${rows.length} objets en vente sur ${esc(server.name)}${top ? `. Le plus rentable : <b>${esc(top.g.name)}</b> (+${kinah(top.profit)} par craft)` : ""}.</p>`
      : `<div class="empty">Aucun objet ne correspond à ces filtres.</div>`;
    const shown = rows.slice(0, 150);
    let html = `<thead><tr><th>Objet</th><th class="r">Coût des matériaux</th><th class="r">Vente HV</th><th class="r">Bénéfice par craft</th><th class="r">Marge</th><th class="r">Annonces</th><th></th></tr></thead><tbody>`;
    for (const r of shown) {
      const pos = r.profit > 0;
      const extra = [PROF[r.prof] || r.prof, r.mastery ? "maîtrise " + r.mastery : "", r.qty > 1 ? r.qty + " par craft" : "",
        r.combo ? `combo ${Math.round(r.combo.p * 100)} % → ${nameOf(r.combo.id)}${r.combo.price != null ? " (" + kinah(r.combo.price) + ")" : ""}` : ""].filter(Boolean).join(" · ");
      html += `<tr><td>${gdot(r.id)}${esc(r.g.name)}${lvlTag(r.g.lvl)}<span class="en">${esc(extra)}</span></td>
        <td class="r num">${kinah(r.cost)}</td>
        <td class="r num">${kinah(r.price)}<span class="en">${r.combo ? "moyenne nette " + kinah(r.revenue) : "net " + kinah(r.revenue)}</span></td>
        <td class="r num ${pos ? "pos" : "neg"}">${pos ? "+" : "−"} ${kinah(Math.abs(r.profit))}</td>
        <td class="r num ${pos ? "pos" : "neg"}">${pos ? "+" : "−"}${Math.abs(Math.round(r.margin * 100))} %</td>
        <td class="r num muted">${r.listings != null ? r.listings : "—"}</td>
        <td class="r"><button class="linkish" type="button" data-goal="${esc(r.g.key)}">Détail</button></td></tr>`;
    }
    if (rows.length > shown.length) html += `<tr><td colspan="7" class="muted small">${rows.length - shown.length} autres objets : affine la recherche.</td></tr>`;
    $("rtable").innerHTML = rows.length ? html + "</tbody>" : "";
  }
  const marketIdOf = g => g.ids.find(id => PR.prices[id] || overrides[id] != null) || null;
  let rTimer = 0;
  $("rsearch").addEventListener("input", () => { clearTimeout(rTimer); rTimer = setTimeout(renderProfit, 150); });
  $("rsort").addEventListener("change", renderProfit);
  $("rmin").addEventListener("change", renderProfit);
  $("rtable").addEventListener("click", e => {
    const b = e.target.closest("button[data-goal]"); if (!b) return;
    const g = GROUPS.get(b.dataset.goal); if (!g) return;
    showTab("tab-calc"); pickGoal(g);
  });

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
    refreshView();
  }
  $("server").addEventListener("change", () => loadServer($("server").value));

  async function boot() {
    const o = load("atelier-opts", null);
    if (o) { $("optCombo").checked = o.combo !== false; $("optResale").checked = o.resale !== false; $("optNpc").checked = o.npc !== false; }
    renderCats();
    try {
      const [cat, srv] = await Promise.all([fetch("data/catalog.json", { cache: "no-cache" }).then(r => r.json()), fetch("data/servers.json", { cache: "no-cache" }).then(r => r.json())]);
      CAT = cat; SERVERS = srv.servers;
      try { const cfg = await fetch("config.json", { cache: "no-cache" }).then(r => r.json()); PROXY = String(cfg.proxy || "").replace(/\/$/, ""); } catch (e) { PROXY = ""; }
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
