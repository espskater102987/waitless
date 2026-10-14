#!/bin/bash
# Supervisor: keeps the server alive; optionally a cloudflared quick tunnel (TUNNEL=1).
# Usage: nohup setsid ./run.sh >/dev/null 2>&1 &
cd "$(dirname "$0")"; export PORT=${PORT:-8787} DEV_ALLOW_FAR=${DEV_ALLOW_FAR:-0}
( while true; do python3 server.py >>server.log 2>&1; sleep 2; done ) &
[ "$TUNNEL" = 1 ] || { wait; exit; }
while true; do
  ./bin/cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:$PORT 2>&1 | tee -a tunnel.log | \
    grep --line-buffered -o 'https://[a-z0-9-]*\.trycloudflare\.com' | while read u; do echo "$u" > PUBLIC_URL.txt; done
  sleep 5
done
