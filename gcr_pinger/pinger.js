#!/usr/bin/env node
/**
 * gcr_pinger — Cloud Run Job qui mesure la latence tools/list de chaque MCP server.
 *
 * Déclenché toutes les 30 minutes en relay par trigger_pingers.yml (GitHub Actions).
 * Écrit le résultat dans GCS : gs://<GCS_BUCKET>/<PINGER_LABEL>/tools_list_<timestamp>.json
 *
 * Env vars requis :
 *   GCS_BUCKET      — nom du bucket GCS cible, ex. "mcp-benchmark-results"
 *   PINGER_LABEL    — identifiant de la région, ex. "paris_fr"
 *   GCR_REGION      — région GCR, ex. "europe-west9"
 *
 * Env vars auto-injectés par Cloud Run Jobs :
 *   CLOUD_RUN_JOB        — nom du job, ex. "mcp-pinger-paris-fr"
 *   CLOUD_RUN_EXECUTION  — identifiant d'exécution
 */

import { hostname, platform } from "os";
import { lookup } from "dns/promises";

// --- Configuration ---
const GCS_BUCKET = process.env.GCS_BUCKET;
const DRY_RUN = process.env.DRY_RUN === "true";

const PINGER_LABEL = process.env.PINGER_LABEL ?? null;
const GCR_REGION = process.env.GCR_REGION ?? null;
const CLOUD_RUN_JOB = process.env.CLOUD_RUN_JOB ?? null;

const timeout_ms = parseInt(process.env.TIMEOUT_MS ?? "15000", 10);
const jitter_ms = 0; // pas de jitter — GitHub Actions relay gère le timing

if (!DRY_RUN && !GCS_BUCKET) {
  console.error("ERREUR : GCS_BUCKET non défini.");
  console.error("Pour tester sans écriture GCS : DRY_RUN=true node pinger.js");
  process.exit(1);
}

// --- pinger_source_url (identifie cette instance pinger dans les résultats) ---
const pinger_source_url = CLOUD_RUN_JOB && GCR_REGION
  ? `gcr://${GCR_REGION}/${CLOUD_RUN_JOB}`
  : null;

// --- Endpoints (source de vérité : repo mcp_server_per_hosting_provider) ---
const ENDPOINTS_URL =
  "https://raw.githubusercontent.com/mcp-server-hosting-providers-benchmark/mcp_server_per_hosting_provider/main/mcp_servers_under_test.json";

const endpoints_res = await fetch(ENDPOINTS_URL, { signal: AbortSignal.timeout(10000) });
if (!endpoints_res.ok) {
  console.error(`Impossible de récupérer mcp_servers_under_test.json (${endpoints_res.status})`);
  process.exit(1);
}
const raw = await endpoints_res.json();

const servers = Object.entries(raw)
  .filter(([key]) => !key.startsWith("_"))
  .map(([name, url]) => ({ name, url }));

if (servers.length === 0) {
  console.error("Aucun serveur dans mcp_servers_under_test.json.");
  process.exit(1);
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

// --- Mesure tools/list ---
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

// --- Récupère le token OAuth du metadata server (disponible dans tout Cloud Run Job) ---
async function get_gcp_access_token() {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) throw new Error(`metadata server ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

// --- Écrit le résultat dans GCS via l'API REST ---
async function push_result_to_gcs(object_name, data) {
  const token = await get_gcp_access_token();
  const body = JSON.stringify(data, null, 2);
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(object_name)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GCS API ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Run ---
const server_label = PINGER_LABEL ?? "unknown";

const observed_call_chain_script = {
  role: "mcpclient",
  hostname: hostname(),
  platform: platform(),
  node_version: process.version,
  pinger_source_url,
  fetch_count: 0,
};

console.log(`  mcpclient : ${server_label} (${GCR_REGION ?? "région inconnue"})`);
console.log(`\ntools/list — ${servers.length} serveurs — timeout ${timeout_ms}ms\n`);

const results = [];

for (const { name, url } of servers) {
  process.stdout.write(`  [${name}] ...`);

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

  const roundtrip_ms = Math.round(
    result.timestamps.mcpclient.request_end_ms - result.timestamps.mcpclient.request_start_ms
  );
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

// --- Résumé console ---
const ok_results = results.filter(r => r.ok);
console.log(`\nRésumé : ${ok_results.length}/${results.length} succès`);

// --- Écriture GCS ---
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `tools_list_${timestamp}.json`;
// Organisé par région : sydney_au/tools_list_2026-04-18T...json
const object_name = `${server_label}/${filename}`;
const result_data = {
  benchmark: "tools/list",
  date: new Date().toISOString(),
  server_label,
  pinger_source_url,
  timeout_ms,
  jitter_ms,
  results,
};

if (DRY_RUN) {
  console.log("\n── DRY RUN — résultats complets (pas d'écriture GCS) ──");
  console.log(JSON.stringify(result_data, null, 2));
} else {
  console.log(`\nÉcriture GCS gs://${GCS_BUCKET}/${object_name}`);
  try {
    await push_result_to_gcs(object_name, result_data);
    console.log(`OK — ${object_name}`);
  } catch (err) {
    console.error(`ERREUR écriture GCS : ${err.message}`);
    process.exit(1);
  }
}
