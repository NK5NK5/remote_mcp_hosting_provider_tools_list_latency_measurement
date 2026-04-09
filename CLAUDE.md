# remote_mcp_hosting_provider_tools_list_latency_measurement

## Objectif

Mesurer la latence du `tools/list` pour des remote MCP servers hébergés chez différents providers, depuis le point de vue d'un client MCP (Claude terminal, Claude desktop, etc.).

## Ce que ce répertoire fait

- Appelle `tools/list` sur chaque endpoint configuré dans `endpoints.json`
- Enregistre les timestamps mcpclient et mcpserver, la géo du client et des serveurs
- Sauvegarde les résultats en JSON dans `results/`

## Ce que ce répertoire ne fait pas

- Analyser ou agréger les résultats → utiliser `remote_mcp_hosting_provider_tools_list_latency_analysis`
- Appeler des tools spécifiques (`tools/call`) → hors scope, réservé aux servers témoins compatibles

## Structure

- `benchmark.js` — script client qui orchestre les mesures
- `endpoints.json` — liste des remote MCP servers à tester
- `results/` — fichiers `tools_list_TIMESTAMP.json`
- `naming_contract.json` — manifest machine-readable de ce répertoire

## Lancer une mesure

```bash
node benchmark.js
```

## Format des fichiers de résultats

```json
{
  "benchmark": "tools/list",
  "date": "2026-04-09T...",
  "timeout_ms": 15000,
  "mcpclient_context": {
    "hostname": "...",
    "platform": "darwin",
    "public_ip": "...",
    "geo": { "city": "Paris", "country_code": "FR" }
  },
  "results": [{
    "name": "cloudflare_workers",
    "ok": true,
    "timestamps": {
      "mcpclient": { "request_start_ms": ..., "request_end_ms": ... },
      "mcpserver": { "start_ms": ..., "end_ms": ... }
    },
    "observed_call_chain": [...]
  }]
}
```

## Providers témoins déployés

Repo : `NK5NK5/remote_mcp_server_per_hosting_provider`

| Provider | URL |
|----------|-----|
| cloudflare_workers | https://remote-mcp-server-cloudflare-workers.reboot.workers.dev/mcp |
| vercel | https://vercel-delta-virid-14.vercel.app/api/mcp |
| netlify | https://mcp-benchmark-netlify.netlify.app/mcp |
| railway | https://mcp-benchmark-railway-production.up.railway.app/mcp |
| supabase_edge_functions | https://etidrwgmegfsusnrrpyc.supabase.co/functions/v1/mcp |
| fermyon | https://remote-mcp-server-fermyon-enkfidvd.fermyon.app/mcp |
| valtown | https://NK5--1562c5ce32c411f1b64f42dde27851f2.web.val.run |
| render | https://mcp-hosting-benchmark.onrender.com/mcp |

## Note sur les horloges

`mcpclient` timestamps = `performance.now()` relatif au démarrage du process Node.js.
`mcpserver` timestamps = `performance.now()` relatif au runtime serveur.
Les deux ne sont **pas comparables entre elles** — seules les durées au sein de chaque horloge sont fiables.

## Contexte de mesure actuel

Runs depuis un MacBook à Paris. La latence inclut le réseau Paris → provider → Paris.

## Phases

- **Phase 1** ✅ : runs manuels via `tools/list`, latence et géo capturés
- **Phase 2** (prochaine) : automatisation — cycle cold/warm toutes les 2h
- **Phase 3** : déployer benchmark.js sur ~10 régions géographiques
