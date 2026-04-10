#!/usr/bin/env node

/**
 * remote_mcp_server_tools_list_cold_start_measurement
 *
 * Phase 1 : mesure la latence de chaque MCP server via tools/list.
 * Un seul run par provider — représente la première requête d'une conversation LLM.
 *
 * Usage:
 *   node benchmark.js
 *   node benchmark.js --group servers_temoins
 *   node benchmark.js --timeout 10000
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { hostname, platform, version as node_version } from "os";
import { lookup } from "dns/promises";

// --- Args ---
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, val, i, arr) => {
    if (val.startsWith("--")) acc.push([val.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

// --- Config (config.json + overrides CLI) ---
const config_path = join(import.meta.dirname, "config.json");
const config = existsSync(config_path) ? JSON.parse(readFileSync(config_path, "utf-8")) : {};

const timeout_ms = parseInt(args.timeout ?? config.timeout_ms ?? "15000", 10);
const group_filter = args.group ?? null;
const jitter_max_s = parseInt(args.jitter ?? config.jitter_max_seconds ?? "0", 10);

// --- Jitter ---
let jitter_ms = 0;
if (jitter_max_s > 0) {
  jitter_ms = Math.floor(Math.random() * jitter_max_s * 1000);
  process.stdout.write(`Jitter : attente ${jitter_ms}ms avant démarrage...\n`);
  await new Promise(resolve => setTimeout(resolve, jitter_ms));
}

// --- Endpoints (source de vérité : repo remote_mcp_server_per_hosting_provider) ---
const ENDPOINTS_URL = "https://raw.githubusercontent.com/NK5NK5/remote_mcp_server_per_hosting_provider/main/endpoints.json";
const endpoints_res = await fetch(ENDPOINTS_URL, { signal: AbortSignal.timeout(10000) });
if (!endpoints_res.ok) {
  console.error(`Impossible de récupérer endpoints.json depuis GitHub (${endpoints_res.status})`);
  process.exit(1);
}
const raw = await endpoints_res.json();

const servers = Object.entries(raw)
  .filter(([key]) => !key.startsWith("_"))
  .filter(([name]) => group_filter === null || name === group_filter)
  .map(([name, url]) => ({ name, url }));

if (servers.length === 0) {
  console.error("Aucun serveur trouvé dans endpoints.json.");
  process.exit(1);
}

// --- Géolocalisation d'une IP ---
async function geolocate_self() {
  // Récupère IPv4 et IPv6 séparément via ipify
  const [res4, res6] = await Promise.allSettled([
    fetch("https://api4.ipify.org?format=json", { signal: AbortSignal.timeout(5000) }),
    fetch("https://api6.ipify.org?format=json", { signal: AbortSignal.timeout(5000) }),
  ]);
  const ipv4 = res4.status === "fulfilled" ? (await res4.value.json().catch(() => null))?.ip ?? null : null;
  const ipv6 = res6.status === "fulfilled" ? (await res6.value.json().catch(() => null))?.ip ?? null : null;

  // Géolocalise l'IP primaire (IPv4 préféré)
  const primary_ip = ipv4 ?? ipv6;
  if (!primary_ip) throw new Error("impossible de résoudre l'IP publique");
  const geo_res = await fetch(
    `http://ip-api.com/json/${primary_ip}?fields=status,query,city,regionName,country,countryCode,lat,lon`,
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await geo_res.json();
  if (data.status !== "success") throw new Error("ip-api.com: " + data.message);

  return {
    ip: primary_ip,
    ipv4,
    ipv6,
    geo: {
      city: data.city,
      region: data.regionName,
      country: data.country,
      country_code: data.countryCode,
      latitude: data.lat,
      longitude: data.lon,
    },
  };
}

async function geolocate_ip(ip) {
  const res = await fetch(
    `http://ip-api.com/json/${ip}?fields=status,city,country,countryCode,lat,lon`,
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();
  if (data.status !== "success") return null;
  return {
    city: data.city,
    country: data.country,
    country_code: data.countryCode,
    latitude: data.lat,
    longitude: data.lon,
  };
}

// --- Résolution DNS + géo d'une URL ---
async function resolve_mcpserver(url) {
  try {
    const hostname_str = new URL(url).hostname;
    const { address } = await lookup(hostname_str);
    const geo = await geolocate_ip(address);
    return { hostname: hostname_str, resolved_ip: address, geo };
  } catch {
    return { hostname: null, resolved_ip: null, geo: null };
  }
}

// --- tools/list request ---
async function measure_tools_list(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);

  const request_start_ms = performance.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: controller.signal,
    });

    let tools = null;
    let parse_error = null;

    try {
      const body = await res.json();
      tools = body?.result?.tools?.map(t => t.name) ?? null;
    } catch (e) {
      parse_error = e.message;
    }

    const request_end_ms = performance.now();
    clearTimeout(timer);

    return {
      ok: res.ok && tools !== null,
      http_status: res.status,
      timestamps: {
        mcpclient: { request_start_ms, request_end_ms },
        mcpserver: {
          start_ms: parseFloat(res.headers.get("X-Mcp-Server-Start-Ms")) || null,
          end_ms: parseFloat(res.headers.get("X-Mcp-Server-End-Ms")) || null,
        },
      },
      tools,
      parse_error: parse_error ?? undefined,
    };
  } catch (err) {
    const request_end_ms = performance.now();
    clearTimeout(timer);

    const is_timeout = err.name === "AbortError";
    return {
      ok: false,
      http_status: null,
      timestamps: {
        mcpclient: { request_start_ms, request_end_ms },
        mcpserver: { start_ms: null, end_ms: null },
      },
      tools: null,
      error: is_timeout ? `timeout (>${timeout_ms}ms)` : (err.message ?? String(err)),
    };
  }
}

// --- Run ---
process.stdout.write(`\nRécupération du contexte mcpclient...`);
let self_context;
try {
  self_context = await geolocate_self();
} catch {
  self_context = { ip: null, geo: null };
}

const geo = self_context.geo;
const server_label = geo?.city && geo?.country_code
  ? `${geo.city.toLowerCase().replace(/\s+/g, "_")}_${geo.country_code.toLowerCase()}`
  : "unknown";

const observed_call_chain_script = {
  role: "mcpclient",
  hostname: hostname(),
  platform: platform(),
  node_version: process.version,
  ip: self_context.ip,
  ipv4: self_context.ipv4,
  ipv6: self_context.ipv6,
  geo: self_context.geo,
  fetch_count: 0, // incrémenté à chaque fetch vers un MCP server
};

process.stdout.write(
  `\r  mcpclient : ${observed_call_chain_script.hostname} — ${self_context.geo?.city ?? "?"}, ${self_context.geo?.country ?? "?"} (${self_context.ip ?? "IP inconnue"})\n`
);

console.log(`\nremote_mcp_server_tools_list_cold_start_measurement — tools/list`);
console.log(`Timeout : ${timeout_ms}ms`);
console.log(`Servers : ${servers.length}\n`);

const results = [];

for (const { name, url } of servers) {
  process.stdout.write(`  [${name}] ...`);

  // Résolution DNS + géo du MCP server (avant la requête)
  const mcpserver_network = await resolve_mcpserver(url);

  const result = await measure_tools_list(url);
  observed_call_chain_script.fetch_count++;

  results.push({
    name,
    url,
    observed_call_chain: [
      { ...observed_call_chain_script },
      {
        role: "mcpserver",
        provider: name,
        url,
        ...mcpserver_network,
      },
    ],
    ...result,
  });

  const roundtrip_ms = Math.round(result.timestamps.mcpclient.request_end_ms - result.timestamps.mcpclient.request_start_ms);
  if (result.ok) {
    process.stdout.write(
      `\r  [${name}] ${roundtrip_ms}ms  tools=[${result.tools.join(", ")}]\n`
    );
  } else {
    process.stdout.write(
      `\r  [${name}] ERREUR — ${result.error ?? `http ${result.http_status}`}\n`
    );
  }
}

// --- Résumé ---
const ok_results = results.filter(r => r.ok);
console.log(`\nRésumé :`);
console.log(`  Succès  : ${ok_results.length}/${results.length}`);

if (ok_results.length > 0) {
  const roundtrips = ok_results.map(r => Math.round(r.timestamps.mcpclient.request_end_ms - r.timestamps.mcpclient.request_start_ms));
  const sorted = [...roundtrips].sort((a, b) => a - b);
  console.log(`  min     : ${sorted[0]}ms`);
  console.log(`  max     : ${sorted[sorted.length - 1]}ms`);
  console.log(`  médiane : ${sorted[Math.floor(sorted.length / 2)]}ms`);

  console.log(`\nClassement :`);
  console.log(`  ${"provider".padEnd(30)} ${"roundtrip".padStart(10)} ${"mcpserver".padStart(10)} ${"network".padStart(10)}`);
  console.log(`  ${"-".repeat(30)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(10)}`);
  [...ok_results]
    .map(r => {
      const roundtrip_ms = Math.round(r.timestamps.mcpclient.request_end_ms - r.timestamps.mcpclient.request_start_ms);
      const mcpserver_ms = (r.timestamps.mcpserver.start_ms !== null && r.timestamps.mcpserver.end_ms !== null)
        ? Math.round(r.timestamps.mcpserver.end_ms - r.timestamps.mcpserver.start_ms)
        : null;
      const network_ms = mcpserver_ms !== null ? roundtrip_ms - mcpserver_ms : null;
      return { ...r, roundtrip_ms, mcpserver_ms, network_ms };
    })
    .sort((a, b) => a.roundtrip_ms - b.roundtrip_ms)
    .forEach((r, i) => {
      const mcpserver = r.mcpserver_ms !== null ? `${r.mcpserver_ms}ms` : "n/a";
      const network = r.network_ms !== null ? `${r.network_ms}ms` : "n/a";
      console.log(`  ${String(i + 1) + ". " + r.name.padEnd(28)} ${String(r.roundtrip_ms + "ms").padStart(10)} ${mcpserver.padStart(10)} ${network.padStart(10)}`);
    });
}

// --- Sauvegarde ---
const results_dir = join(import.meta.dirname, "results");
if (!existsSync(results_dir)) mkdirSync(results_dir);

const filename = `tools_list_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const filepath = join(results_dir, filename);

writeFileSync(filepath, JSON.stringify({
  benchmark: "tools/list",
  date: new Date().toISOString(),
  server_label,
  timeout_ms,
  jitter_ms,
  results,
}, null, 2));

console.log(`\nRésultats : results/${filename}`);
