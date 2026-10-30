// Récupère les données d'A2-Tracker (avec leur accord) et écrit des fichiers JSON compacts
// dans site/data/ : catalogue (objets + recettes), liste des serveurs et prix par serveur.
// Si A2-Tracker refuse l'accès : recettes reprises de la version déjà publiée et prix pris
// chez aion2.exchange (relevé toutes les heures). Lancé par la GitHub Action. Node 20+.
import { mkdir, writeFile, readFile } from "node:fs/promises";

const BASE = "https://a2-tracker.com";
const EX = "https://aion2.exchange/api";
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || "FxT1104/atelier-aion2").split("/");
const SITE = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
const OUT = new URL("../site/data/", import.meta.url);
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url), "utf8"));
const UA = "atelier-aion2 (+" + SITE + ")";
const HEADERS = { "User-Agent": UA, Accept: "application/json", ...(process.env.A2T_HEADERS ? JSON.parse(process.env.A2T_HEADERS) : {}) };
const EXH = { "User-Agent": UA, Accept: "application/json" };
const FULL = ["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME || "");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const blocked = e => /\b(403|429)\b|access_restricted/.test(String(e && e.message));

async function fetchJson(url, headers, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(res.status + " " + res.statusText + " · " + text.slice(0, 160).replace(/\s+/g, " "));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error("réponse non JSON · " + text.slice(0, 160).replace(/\s+/g, " ")); }
      if (data && data.ok === false) throw new Error("ok:false · " + text.slice(0, 160));
      return data;
    } catch (e) {
      last = e;
      if (blocked(e)) break; // un refus ne se règle pas en réessayant
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(url.replace(/^https:\/\//, "") + " : " + last.message);
}
const getJson = path => fetchJson(BASE + path, HEADERS);
const getEx = path => fetchJson(EX + path, EXH);
const getPrev = path => fetchJson(SITE + "data/" + path + "?t=" + Date.now(), { "User-Agent": UA });

await mkdir(new URL("prices/", OUT), { recursive: true });
let a2ok = true;
let servers, catalog;

try {
  // ---------- Serveurs ----------
  const srv = await getJson("/api.servers.ashx");
  servers = srv.servers
    .filter(s => config.regions.includes(s.regionId))
    .map(s => ({ id: s.id, name: s.name, region: s.regionId, regionName: s.regionName, faction: s.faction === "Asmodian" ? "asmodian" : "elyos" }))
    .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name) || a.faction.localeCompare(b.faction));

  // ---------- Catalogue (objets + recettes), en français et en anglais ----------
  const fr = await getJson("/api.crafting.ashx?locale=fr-FR");
  const en = await getJson("/api.crafting.ashx?locale=en-US");
  // Niveaux des objets (base d'objets A2-Tracker), gardés en cache une journée entre deux lancements.
  const CACHE = new URL("../.cache/", import.meta.url);
  await mkdir(CACHE, { recursive: true });
  let levels = null;
  try {
    const c = JSON.parse(await readFile(new URL("levels.json", CACHE), "utf8"));
    if (Date.now() - Date.parse(c.at) < 24 * 3600e3) levels = c.levels;
  } catch (e) {}
  if (!levels) {
    try {
      levels = {};
      for (let page = 1, pages = 1; page <= pages && page <= 60; page++) {
        const d = await getJson(`/api.database.ashx?page=${page}&limit=100&server=2302&locale=fr-FR&sort=name&dir=asc&priced=all&ah=1&unique=1`);
        pages = d.pages || 1;
        for (const it of d.items || []) levels[it.itemId] = [it.itemLevel || 0, it.levelReq || it.equipLevel || 0];
        await sleep(300);
      }
      await writeFile(new URL("levels.json", CACHE), JSON.stringify({ at: new Date().toISOString(), levels }));
    } catch (e) {
      console.warn("Niveaux indisponibles : " + e.message);
      levels = {};
    }
  }

  const items = {};
  for (const [id, v] of Object.entries(fr.items)) {
    const lv = levels[id] || [0, 0];
    items[id] = [v.name, en.items[id] ? en.items[id].name : "", v.grade || "", v.category || "", v.subCategory || "", v.marketKind === "kina-chests" ? 1 : 0, lv[0], lv[1]];
  }
  const tab = x => (x.client && x.client.tab) || {};
  const recipes = fr.recipes
    .filter(x => !x.isComboResult) // les résultats de combo sont portés par la recette parente
    .map(x => [
      x.id,
      x.itemId,
      x.outputQuantity || 1,
      x.method === "convert" ? 1 : 0,
      x.profession || "",
      x.requiredMastery || 0,
      x.faction || "",
      tab(x).mainName || x.category || "",
      tab(x).subName || "",
      x.ingredients.map(i => [
        i.itemId,
        i.quantity,
        // variantes acceptées (autres objets interchangeables, versions liées…)
        [...(i.alternatives || []).map(a => [a.itemId, a.quantity || i.quantity]), ...(i.combine || []).map(a => [a.itemId, a.quantity || i.quantity])],
      ]),
      (x.additionalItemReferences || []).map(a => a.itemId), // équipement à transférer (1 seul consommé)
      x.combo ? [x.combo.itemId, x.combo.quantity || 1, x.combo.probabilityRaw || 0] : 0,
      (x.client && x.client.cost && x.client.cost.amount) || 0,
    ]);
  const npc = {};
  for (const [id, arr] of Object.entries(fr.npcPrices || {})) {
    const o = {};
    for (const e of arr) {
      if (e.currency !== "GoldCombined") continue;
      const p = e.price / (e.bundle || 1);
      const f = e.faction || "all";
      if (o[f] == null || p < o[f]) o[f] = p;
    }
    if (Object.keys(o).length) npc[id] = o;
  }
  catalog = { builtAt: new Date().toISOString(), source: "A2-Tracker", items, recipes, npc };

} catch (e) {
  if (!blocked(e)) throw e;
  a2ok = false;
  console.log("::warning title=A2-Tracker refuse l'accès::" + e.message.replace(/\r?\n/g, " ") + " · recettes reprises de la version publiée, prix pris chez aion2.exchange.");
  const prevSrv = await getPrev("servers.json");
  servers = prevSrv.servers.map(({ id, name, region, regionName, faction }) => ({ id, name, region, regionName, faction }));
  catalog = await getPrev("catalog.json");
}
await writeFile(new URL("catalog.json", OUT), JSON.stringify(catalog));

// ---------- Prix par serveur ----------
const index = { builtAt: new Date().toISOString(), source: a2ok ? "A2-Tracker" : "aion2.exchange", servers: [] };
if (a2ok) {
  for (const s of servers) {
    try {
      const q = await getJson("/api.crafting.ashx?quotes=1&server=" + s.id);
      const prices = {};
      for (const e of q.quotes) {
        if (e.price == null) continue;
        prices[e.itemId] = [Math.round(Number(e.price)), e.listings == null ? null : Number(e.listings), e.status === "current" ? 1 : 0];
      }
      await writeFile(new URL("prices/" + s.id + ".json", OUT), JSON.stringify({ server: s.id, source: "A2-Tracker", asOf: q.asOf, delaySeconds: q.delaySeconds || 0, prices }));
      index.servers.push({ ...s, asOf: q.asOf, priced: Object.keys(prices).length });
    } catch (e) {
      console.warn("Prix indisponibles pour " + s.name + " (" + s.id + ") : " + e.message);
      index.servers.push({ ...s, asOf: null, priced: 0 });
    }
    await sleep(config.delayBetweenServersMs || 400);
  }
} else {
  // aion2.exchange : mêmes numéros d'objets ; serveur 2302 (A2-Tracker) = 12302 chez eux.
  const exMap = new Map();
  try {
    const d = await getEx("/servers");
    const list = Array.isArray(d) ? d : d.servers || d.items || d.data || [];
    if (list[0]) console.log("aion2.exchange /servers, exemple : " + JSON.stringify(list[0]).slice(0, 300));
    for (const x of list) {
      const id = x.server_id ?? x.id, name = String(x.name || x.server_name || "").toLowerCase();
      const race = String(x.race || x.faction || "").toLowerCase();
      const fac = /dark|asmo/.test(race) ? "asmodian" : /light|ely/.test(race) ? "elyos" : "";
      if (id != null && name) exMap.set(name + "|" + fac, id);
    }
  } catch (e) { console.warn("Liste des serveurs aion2.exchange indisponible : " + e.message); }
  const exId = s => exMap.get(String(s.name).toLowerCase() + "|" + s.faction) ?? 10000 + Number(s.id);

  // Rien de nouveau depuis le dernier relevé publié ? On ne recharge pas tout (ils relèvent une fois par heure).
  const ref = servers.find(s => String(s.id) === "2302") || servers[0];
  if (!FULL) {
    try {
      const [ov, prev] = await Promise.all([getEx(`/overview?server=${exId(ref)}&window=24h`), getPrev("servers.json")]);
      const latest = ov && ov.freshness && ov.freshness.latest_snapshot_at;
      const had = (prev.servers.find(s => String(s.id) === String(ref.id)) || {}).asOf;
      if (prev.source === "aion2.exchange" && latest && had && Date.parse(had) >= Date.parse(latest)) {
        console.log("Pas de nouveau relevé chez aion2.exchange depuis " + latest + " : rien à publier.");
        process.exit(3);
      }
    } catch (e) { console.warn("Vérification du relevé impossible : " + e.message); }
  }
  for (const s of servers) {
    const sid = exId(s), prices = {};
    let asOf = null, offset = 0, total = Infinity, pages = 0;
    try {
      while (offset < total && pages < 60) {
        const d = await getEx(`/items?server=${sid}&sort=name&order=asc&window=24h&limit=200&offset=${offset}`);
        total = d.total || 0; pages++;
        const got = d.items || [];
        for (const it of got) {
          if (!it.listed || it.price == null) continue;
          prices[it.item_key] = [Math.round(Number(it.price)), it.listings == null ? null : Number(it.listings), 1];
          if (it.captured_at && (!asOf || it.captured_at > asOf)) asOf = it.captured_at;
        }
        if (!got.length) break;
        offset += got.length;
        await sleep(250);
      }
      await writeFile(new URL("prices/" + s.id + ".json", OUT), JSON.stringify({ server: s.id, source: "aion2.exchange", asOf, delaySeconds: 0, prices }));
      index.servers.push({ ...s, asOf, priced: Object.keys(prices).length });
    } catch (e) {
      console.warn("Prix indisponibles pour " + s.name + " (" + s.id + " → " + sid + ") : " + e.message);
      index.servers.push({ ...s, asOf: null, priced: 0 });
    }
    await sleep(config.delayBetweenServersMs || 400);
  }
}
await writeFile(new URL("servers.json", OUT), JSON.stringify(index));
const ok = index.servers.filter(s => s.priced);
console.log(`OK (${index.source}) : ${Object.keys(catalog.items).length} objets, ${catalog.recipes.length} recettes, ${ok.length}/${servers.length} serveurs avec prix.`);
if (!a2ok) console.log(`::notice title=Prix aion2.exchange::${ok.length}/${servers.length} serveurs, Zikel : ${(index.servers.find(s => String(s.id) === "2302") || {}).priced || 0} objets, relevé ${(index.servers.find(s => String(s.id) === "2302") || {}).asOf}`);
if (!ok.length) process.exit(1);
