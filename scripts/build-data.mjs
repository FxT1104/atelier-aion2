// Récupère les données d'A2-Tracker (avec leur accord) et écrit des fichiers JSON compacts
// dans site/data/ : catalogue (objets + recettes), liste des serveurs et prix par serveur.
// Lancé par la GitHub Action toutes les 10 minutes. Node 20+ (fetch intégré).
import { mkdir, writeFile, readFile } from "node:fs/promises";

const BASE = "https://a2-tracker.com";
const OUT = new URL("../site/data/", import.meta.url);
const config = JSON.parse(await readFile(new URL("../config.json", import.meta.url), "utf8"));
const HEADERS = {
  "User-Agent": "atelier-aion2 (+https://github.com/" + (process.env.GITHUB_REPOSITORY || "atelier-aion2") + ")",
  Accept: "application/json",
  ...(process.env.A2T_HEADERS ? JSON.parse(process.env.A2T_HEADERS) : {}),
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(path, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + path, { headers: HEADERS });
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      const data = await res.json();
      if (data && data.ok === false) throw new Error("ok:false");
      return data;
    } catch (e) {
      last = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(path + " : " + last.message);
}

await mkdir(new URL("prices/", OUT), { recursive: true });

// ---------- Serveurs ----------
const srv = await getJson("/api.servers.ashx");
const servers = srv.servers
  .filter(s => config.regions.includes(s.regionId))
  .map(s => ({ id: s.id, name: s.name, region: s.regionId, regionName: s.regionName, faction: s.faction === "Asmodian" ? "asmodian" : "elyos" }))
  .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name) || a.faction.localeCompare(b.faction));

// ---------- Catalogue (objets + recettes), en français et en anglais ----------
const fr = await getJson("/api.crafting.ashx?locale=fr-FR");
const en = await getJson("/api.crafting.ashx?locale=en-US");
const items = {};
for (const [id, v] of Object.entries(fr.items)) {
  items[id] = [v.name, en.items[id] ? en.items[id].name : "", v.grade || "", v.category || "", v.subCategory || "", v.marketKind === "kina-chests" ? 1 : 0];
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
const catalog = { builtAt: new Date().toISOString(), source: "A2-Tracker", items, recipes, npc };
await writeFile(new URL("catalog.json", OUT), JSON.stringify(catalog));

// ---------- Prix par serveur ----------
const index = { builtAt: catalog.builtAt, servers: [] };
for (const s of servers) {
  try {
    const q = await getJson("/api.crafting.ashx?quotes=1&server=" + s.id);
    const prices = {};
    for (const e of q.quotes) {
      if (e.price == null) continue;
      prices[e.itemId] = [Math.round(Number(e.price)), e.listings == null ? null : Number(e.listings), e.status === "current" ? 1 : 0];
    }
    await writeFile(new URL("prices/" + s.id + ".json", OUT), JSON.stringify({ server: s.id, asOf: q.asOf, delaySeconds: q.delaySeconds || 0, prices }));
    index.servers.push({ ...s, asOf: q.asOf, priced: Object.keys(prices).length });
  } catch (e) {
    console.warn("Prix indisponibles pour " + s.name + " (" + s.id + ") : " + e.message);
    index.servers.push({ ...s, asOf: null, priced: 0 });
  }
  await sleep(config.delayBetweenServersMs || 400);
}
await writeFile(new URL("servers.json", OUT), JSON.stringify(index));
console.log(`OK : ${Object.keys(items).length} objets, ${recipes.length} recettes, ${index.servers.filter(s => s.priced).length}/${servers.length} serveurs avec prix.`);
