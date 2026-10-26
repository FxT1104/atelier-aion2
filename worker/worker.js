// Relais Cloudflare entre le site et l'historique des prix d'A2-Tracker.
// Le navigateur ne peut pas lire A2-Tracker directement (CORS) : ce relais le fait pour lui,
// garde les réponses en cache 10 minutes et n'accepte que les demandes venant du site.
const ALLOWED_ORIGINS = ["https://fxt1104.github.io"];
const UPSTREAM = "https://a2-tracker.com/api.history.ashx";
const CACHE_SECONDS = 600;
const MAX_ITEMS = 30;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ ok: false, error: "method" }, 405, cors);

    const url = new URL(request.url);
    if (url.pathname !== "/history") return json({ ok: false, error: "not_found" }, 404, cors);

    const server = url.searchParams.get("server") || "";
    const days = url.searchParams.get("days") || "7";
    const items = (url.searchParams.get("items") || "").split(",").filter(Boolean);
    if (!/^\d{1,6}$/.test(server) || !["1", "7", "30"].includes(days) || !items.length || items.length > MAX_ITEMS || !items.every(i => /^\d{1,12}$/.test(i))) {
      return json({ ok: false, error: "bad_request" }, 400, cors);
    }

    const out = {};
    await Promise.all([...new Set(items)].map(async id => {
      out[id] = await history(id, server, days, ctx);
    }));
    return json({ ok: true, server, days: Number(days), items: out }, 200, { ...cors, "Cache-Control": "public, max-age=300" });
  },
};

async function history(item, server, days, ctx) {
  const key = new Request(`https://cache.atelier-aion2/v2/history?item=${item}&server=${server}&days=${days}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit.json();
  let data;
  try {
    const res = await fetch(`${UPSTREAM}?item=${item}&server=${server}&days=${days}`, {
      headers: { Accept: "application/json", "User-Agent": "atelier-aion2-relais (+https://fxt1104.github.io/atelier-aion2/)" },
    });
    if (!res.ok) return null;
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
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` } })));
  return data;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
