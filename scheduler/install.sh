#!/usr/bin/env bash
# install.sh — installe les crontabs de benchmark sur un serveur Linux
# Idempotent : ne duplique pas les entrées si déjà installées.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRONTAB_MARKER="mcp-benchmark-autogen"

echo "=== MCP Benchmark Installer ==="
echo "BENCH_DIR : $BENCH_DIR"

# 1. Vérifier Node.js >= 20
NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERREUR : Node.js >= 20 requis (fetch natif). Version détectée : $(node --version 2>/dev/null || echo 'non installé')"
  exit 1
fi
echo "Node.js : $(node --version) ✓"

# 2. Créer le dossier logs/
mkdir -p "$BENCH_DIR/logs"
echo "logs/   : créé ✓"

# 3. Vérifier NTP (Linux seulement)
if command -v timedatectl &>/dev/null; then
  NTP_STATUS=$(timedatectl show --property=NTPSynchronized --value 2>/dev/null || echo "unknown")
  if [ "$NTP_STATUS" = "yes" ]; then
    echo "NTP     : synchronisé ✓"
  else
    echo "AVERTISSEMENT : NTP non synchronisé. La synchronisation inter-serveurs sera dégradée."
    echo "  → sudo systemctl enable --now systemd-timesyncd"
  fi
fi

# 4. Injecter les entrées crontab (si pas déjà présentes)
CRON_ENTRY_1="0 */2 * * * cd $BENCH_DIR && node benchmark.js --jitter 300 >> $BENCH_DIR/logs/tools_list.log 2>&1 # $CRONTAB_MARKER"
CRON_ENTRY_2="50 0,2,4,6,8,10,12,14,16,18,20,22 * * * cd $BENCH_DIR && node tools_call_benchmark.js --jitter 300 >> $BENCH_DIR/logs/tools_call.log 2>&1 # $CRONTAB_MARKER"

CURRENT_CRONTAB=$(crontab -l 2>/dev/null || true)

if echo "$CURRENT_CRONTAB" | grep -qF "$CRONTAB_MARKER"; then
  echo "Crontab : entrées déjà présentes — rien à faire ✓"
else
  (echo "$CURRENT_CRONTAB"; echo "$CRON_ENTRY_1"; echo "$CRON_ENTRY_2") | crontab -
  echo "Crontab : 2 entrées ajoutées ✓"
fi

# 5. Smoke test (optionnel)
echo ""
read -r -p "Lancer un smoke test maintenant ? (node benchmark.js --timeout 5000) [o/N] " REPLY
if [[ "$REPLY" =~ ^[Oo]$ ]]; then
  echo ""
  cd "$BENCH_DIR" && node benchmark.js --timeout 5000
fi

echo ""
echo "=== Installation terminée ==="
echo "Prochain run tools/list : à la prochaine heure paire UTC (+ jitter)"
echo "Prochain run tools/call : 50min après l'heure paire UTC (+ jitter)"
