// Relais Cloudflare d'Atelier Aion 2.
// 1. /history : historique des prix (A2-Tracker, ou aion2.exchange en secours) pour le site.
// 2. /alerts  : alertes Discord. Chaque heure, le relais recalcule le coût des listes de courses enregistrées
//    (ou le bénéfice d'un craft) avec les prix actuels et prévient sur Discord quand le seuil est franchi.
const ALLOWED_ORIGINS = ["https://fxt1104.github.io"];
const SITE_PREFIX = "https://fxt1104.github.io/atelier-aion2/";
const A2T = "https://a2-tracker.com";
const EX = "https://aion2.exchange/api"; // secours quand A2-Tracker refuse l'accès (relevé une fois par heure)
const UA = "atelier-aion2-relais (+https://fxt1104.github.io/atelier-aion2/)";
const CACHE_SECONDS = 600;
const MAX_ITEMS = 30;
const TAX = 0.12;
const MAX_ALERTS_PER_WEBHOOK = 10;
const MAX_ALERTS_TOTAL = 250; // reste dans les limites gratuites de Cloudflare avec une vérification toutes les 5 min
const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,25}\/[\w-]{20,120}$/;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/history" && request.method === "GET") return await historyRoute(url, ctx, cors);
      if (url.pathname === "/prices" && request.method === "GET") {
        const server = url.searchParams.get("server") || "";
        if (!/^\d{1,6}$/.test(server)) return json({ ok: false, error: "bad_request" }, 400, cors);
        return json({ ok: true, ...(await serverQuotes(server)) }, 200, { ...cors, "Cache-Control": "public, max-age=60" });
      }
      if (url.pathname === "/alerts" && request.method === "POST") {
        if (!allowed) return json({ ok: false, error: "origin" }, 403, cors);
        return await createAlert(request, env, cors);
      }
      const m = url.pathname.match(/^\/alerts\/([0-9a-f-]{36})$/);
      if (m && request.method === "GET") return await getAlert(m[1], url, env, cors);
      if (m && request.method === "DELETE") return await deleteAlert(m[1], url, env, cors);
      return json({ ok: false, error: "not_found" }, 404, cors);
    } catch (e) {
      return json({ ok: false, error: "server", message: String(e && e.message || e) }, 500, cors);
    }
  },

  // Vérification des alertes toutes les 5 minutes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAlerts(env));
  },
};

// ================= Historique =================
async function historyRoute(url, ctx, cors) {
  const server = url.searchParams.get("server") || "";
  const days = url.searchParams.get("days") || "7";
  const items = (url.searchParams.get("items") || "").split(",").filter(Boolean);
  if (!/^\d{1,6}$/.test(server) || !["1", "7", "30"].includes(days) || !items.length || items.length > MAX_ITEMS || !items.every(i => /^\d{1,12}$/.test(i))) {
    return json({ ok: false, error: "bad_request" }, 400, cors);
  }
  const out = {};
  await Promise.all([...new Set(items)].map(async id => { out[id] = await history(id, server, days, ctx); }));
  return json({ ok: true, server, days: Number(days), items: out }, 200, { ...cors, "Cache-Control": "public, max-age=300" });
}

async function history(item, server, days, ctx) {
  const key = new Request(`https://cache.atelier-aion2/v2/history?item=${item}&server=${server}&days=${days}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  let data, ttl = CACHE_SECONDS;
  try {
    const res = await fetch(`${A2T}/api.history.ashx?item=${item}&server=${server}&days=${days}`, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) {
      data = await exHistory(item, server, days);
      if (!data) return null;
      ttl = 1800; // relevés horaires : inutile de redemander plus souvent
      ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
      return data;
    }
    const raw = await res.json();
    // Version compacte : [horodatage en secondes, prix, annonces].
    // Avant « hourly.until », A2-Tracker donne un prix le plus bas par heure ; ensuite, chaque relevé.
    const toSec = d => Math.round(Date.parse(d) / 1000);
    const hourly = raw.hourly && Array.isArray(raw.hourly.hours) ? raw.hourly.hours : [];
    const until = raw.hourly && raw.hourly.until ? toSec(raw.hourly.until) : 0;
    const obs = [];
    if (raw.carryIn && raw.carryIn.price != null) obs.push([toSec(raw.period && raw.period.since ? raw.period.since : raw.carryIn.observedAt), Math.round(Number(raw.carryIn.price)), raw.carryIn.listings == null ? null : Number(raw.carryIn.listings)]);
    for (const h of hourly) if (h.lowest != null && toSec(h.hourStart) < until) obs.push([toSec(h.hourStart), Math.round(Number(h.lowest)), null]);
    for (const o of raw.observations || []) if (o.price != null) obs.push([toSec(o.observedAt), Math.round(Number(o.price)), o.listings == null ? null : Number(o.listings)]);
    obs.sort((a, b) => a[0] - b[0]);
    data = { obs };
  } catch (e) {
    return null;
  }
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } })));
  return data;
}

// Numéro du serveur chez aion2.exchange (écrit par la mise à jour du site dans servers.json ; sinon 10000 + numéro).
async function exServerId(server) {
  try {
    const idx = await sitePublished("data/servers.json", 3600);
    const s = (idx.servers || []).find(x => String(x.id) === String(server));
    if (s && s.exId) return s.exId;
  } catch (e) {}
  return 10000 + Number(server);
}
async function exHistory(item, server, days) {
  try {
    const sid = await exServerId(server);
    const range = days === "1" ? "24h" : days + "d";
    const res = await fetch(`${EX}/items/${item}/prices?server=${sid}&range=${range}`, { headers: { Accept: "application/json", "User-Agent": UA } });
    if (!res.ok) return null;
    const raw = await res.json();
    const obs = [];
    for (const p of raw.points || []) if (p.low != null) obs.push([Math.round(Date.parse(p.ts) / 1000), Math.round(Number(p.low)), p.listings == null ? null : Number(p.listings)]);
    obs.sort((a, b) => a[0] - b[0]);
    return { obs, source: "aion2.exchange" };
  } catch (e) {
    return null;
  }
}
// Fichier publié avec le site (prix relevés par la mise à jour), gardé en cache.
async function sitePublished(path, seconds) {
  const key = new Request(`https://cache.atelier-aion2/v2/site/${path}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(SITE_PREFIX + path, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("fichier du site indisponible (" + res.status + ")");
  const data = await res.json();
  await cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` } }));
  return data;
}

// ================= Prix actuels d'un serveur =================
// Prix actuels d'un serveur, gardés 90 secondes en cache (A2-Tracker les publie avec 5 min de retard).
async function serverQuotes(server) {
  const key = new Request(`https://cache.atelier-aion2/v2/quotes?server=${server}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(`${A2T}/api.crafting.ashx?quotes=1&server=${server}`, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!res.ok) {
    // A2-Tracker refuse : on reprend les prix publiés avec le site (aion2.exchange, une fois par heure).
    const d = await sitePublished(`data/prices/${server}.json`, 300);
    if (!d || !d.prices) throw new Error("prix indisponibles (" + res.status + ")");
    return { server, asOf: d.asOf || null, delaySeconds: 0, source: d.source || "site", prices: d.prices };
  }
  const raw = await res.json();
  const prices = {};
  for (const q of raw.quotes || []) {
    if (q.price == null) continue;
    prices[q.itemId] = [Math.round(Number(q.price)), q.listings == null ? null : Number(q.listings), q.status === "current" ? 1 : 0];
  }
  const data = { server, asOf: raw.asOf || null, delaySeconds: raw.delaySeconds || 0, prices };
  await cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=90" } }));
  return data;
}
async function serverPrices(server) {
  const q = await serverQuotes(server);
  const prices = {};
  for (const [id, v] of Object.entries(q.prices)) prices[id] = v[0];
  return { asOf: q.asOf, prices };
}

// Valeur suivie par l'alerte : coût de la liste de courses, ou bénéfice d'un craft.
function evaluate(a, prices) {
  let cost = a.fixed - a.credit;
  for (const [id, q] of a.buy) {
    const p = prices[id];
    if (p == null) return { value: null, missing: id };
    cost += q * p;
  }
  if (a.kind !== "profit") return { value: cost };
  let revenue = 0;
  for (const [id, w] of a.sell) {
    const p = prices[id];
    if (p == null) return { value: null, missing: id };
    revenue += w * p * (1 - TAX);
  }
  return { value: revenue - cost };
}
const hits = (a, v) => a.kind !== "profit" ? v <= a.threshold : v >= a.threshold;
// Pour éviter les messages en boucle : l'alerte se réarme quand on repasse nettement de l'autre côté du seuil.
const rearms = (a, v) => a.kind !== "profit" ? v > a.threshold * 1.02 : v < a.threshold - Math.abs(a.threshold) * 0.02;

// ================= Création / lecture / suppression =================
async function createAlert(request, env, cors) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400, cors); }
  const err = m => json({ ok: false, error: "invalid", message: m }, 400, cors);
  const num = v => typeof v === "number" && isFinite(v);
  const pairs = (arr, max) => Array.isArray(arr) && arr.length <= max && arr.every(x => Array.isArray(x) && x.length === 2 && Number.isInteger(x[0]) && x[0] > 0 && num(x[1]) && x[1] > 0);
  if (typeof b.webhook !== "string" || !WEBHOOK_RE.test(b.webhook.trim())) return err("Adresse de webhook Discord invalide.");
  if (!["cost", "profit", "price"].includes(b.kind)) return err("Type d'alerte inconnu.");
  if (b.kind === "price" && (!Array.isArray(b.buy) || b.buy.length !== 1)) return err("Une alerte de prix porte sur un seul objet.");
  if (typeof b.server !== "string" || !/^\d{1,6}$/.test(b.server)) return err("Serveur invalide.");
  if (!pairs(b.buy, 80) || !b.buy.length) return err("Liste de courses invalide.");
  if (b.kind === "profit" && (!pairs(b.sell, 4) || !b.sell.length)) return err("Objet vendu invalide.");
  if (!num(b.threshold) || !num(b.fixed || 0) || !num(b.credit || 0)) return err("Seuil invalide.");
  const label = String(b.label || "").slice(0, 120);
  const serverLabel = String(b.serverLabel || "").slice(0, 60);
  const link = typeof b.url === "string" && b.url.startsWith(SITE_PREFIX) ? b.url.slice(0, 500) : SITE_PREFIX;
  const webhook = b.webhook.trim();

  const list = await env.ALERTS.list({ prefix: "a:" });
  if (list.keys.length >= MAX_ALERTS_TOTAL) return err("Trop d'alertes enregistrées sur le site pour le moment.");
  const h = await hash(webhook);
  if (list.keys.filter(k => k.metadata && k.metadata.h === h).length >= MAX_ALERTS_PER_WEBHOOK) return err(`Maximum ${MAX_ALERTS_PER_WEBHOOK} alertes par salon Discord.`);

  const alert = {
    id: crypto.randomUUID(), key: randomHex(16), webhook, kind: b.kind, server: b.server, serverLabel, label, url: link,
    buy: b.buy, sell: b.kind === "profit" ? b.sell : [], fixed: b.fixed || 0, credit: b.credit || 0, threshold: Math.round(b.threshold),
    triggered: false, createdAt: new Date().toISOString(), lastSent: null,
  };
  let current = null;
  try { current = evaluate(alert, (await serverPrices(alert.server)).prices).value; } catch (e) {}
  // Message de test : vérifie que le webhook marche avant d'enregistrer.
  const test = await discord(webhook, {
    title: "Alerte enregistrée : " + (label || "craft"),
    url: link,
    color: 0x563a86,
    description: ({
      cost: `Je te préviens ici quand ta liste de courses passe sous **${kinah(alert.threshold)}** Kinah`,
      price: `Je te préviens ici quand le prix passe sous **${kinah(alert.threshold)}** Kinah`,
      profit: `Je te préviens ici quand ce craft rapporte plus de **${kinah(alert.threshold)}** Kinah`,
    })[alert.kind] +
      (serverLabel ? ` sur ${serverLabel}` : "") + "." + (current != null ? `\nValeur actuelle : **${kinah(current)}** Kinah.` : "") +
      "\nVérification toutes les 5 minutes.",
  });
  if (!test.ok) return err("Discord a refusé le message de test : vérifie l'adresse du webhook.");
  await env.ALERTS.put("a:" + alert.id, JSON.stringify(alert), { metadata: { h } });
  return json({ ok: true, id: alert.id, key: alert.key, current }, 200, cors);
}

async function loadOwned(id, url, env) {
  const raw = await env.ALERTS.get("a:" + id);
  if (!raw) return null;
  const a = JSON.parse(raw);
  return a.key === url.searchParams.get("key") ? a : false;
}

async function getAlert(id, url, env, cors) {
  const a = await loadOwned(id, url, env);
  if (a === null) return json({ ok: false, error: "gone" }, 404, cors);
  if (a === false) return json({ ok: false, error: "forbidden" }, 403, cors);
  let current = null;
  try { current = evaluate(a, (await serverPrices(a.server)).prices).value; } catch (e) {}
  return json({ ok: true, label: a.label, kind: a.kind, threshold: a.threshold, serverLabel: a.serverLabel, current, triggered: a.triggered, lastSent: a.lastSent, url: a.url }, 200, cors);
}

async function deleteAlert(id, url, env, cors) {
  const a = await loadOwned(id, url, env);
  if (a === null) return json({ ok: true }, 200, cors);
  if (a === false) return json({ ok: false, error: "forbidden" }, 403, cors);
  await env.ALERTS.delete("a:" + id);
  return json({ ok: true }, 200, cors);
}

// ================= Vérification périodique =================
async function checkAlerts(env) {
  let cursor, keys = [];
  do {
    const page = await env.ALERTS.list({ prefix: "a:", cursor });
    keys = keys.concat(page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const prices = new Map();
  for (const k of keys) {
    const raw = await env.ALERTS.get(k.name);
    if (!raw) continue;
    const a = JSON.parse(raw);
    if (!prices.has(a.server)) {
      try { prices.set(a.server, (await serverPrices(a.server)).prices); } catch (e) { prices.set(a.server, null); }
    }
    const p = prices.get(a.server);
    if (!p) continue;
    const { value } = evaluate(a, p);
    if (value == null) continue;
    if (!a.triggered && hits(a, value)) {
      const res = await discord(a.webhook, {
        title: a.kind === "profit" ? `${a.label} : +${kinah(value)} Kinah par craft` : `${a.label} : ${kinah(value)} Kinah`,
        url: a.url,
        color: a.kind === "profit" ? 0xb07d00 : 0x2f7a52,
        description: ({
          cost: `Ta liste de courses est passée sous ton seuil de **${kinah(a.threshold)}** Kinah`,
          price: `Bonne affaire : le prix le plus bas est passé sous ton seuil de **${kinah(a.threshold)}** Kinah`,
          profit: `Ce craft rapporte maintenant plus que ton seuil de **${kinah(a.threshold)}** Kinah`,
        })[a.kind] + (a.serverLabel ? " sur " + a.serverLabel : "") + (a.kind === "profit" ? "." : ". C'est le moment d'acheter !"),
      });
      if (res.gone) { await env.ALERTS.delete(k.name); continue; }
      if (res.ok) { a.triggered = true; a.lastSent = new Date().toISOString(); await env.ALERTS.put(k.name, JSON.stringify(a), { metadata: k.metadata }); }
    } else if (a.triggered && rearms(a, value)) {
      a.triggered = false;
      await env.ALERTS.put(k.name, JSON.stringify(a), { metadata: k.metadata });
    }
  }
}

async function discord(webhook, embed) {
  try {
    const res = await fetch(webhook + "?wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "Atelier Aion 2", embeds: [{ ...embed, footer: { text: "Prix A2-Tracker · Atelier Aion 2" }, timestamp: new Date().toISOString() }], allowed_mentions: { parse: [] } }),
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 401 };
  } catch (e) {
    return { ok: false, gone: false };
  }
}

// ================= Outils =================
function kinah(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " M";
  return Math.round(n).toLocaleString("fr-FR");
}
function randomHex(bytes) {
  const b = new Uint8Array(bytes); crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function hash(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join("");
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
