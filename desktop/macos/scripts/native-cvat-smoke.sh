#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
WORK="${RUNNER_TEMP:-/tmp}/cvat-native-integration"
PGDATA="$WORK/postgres"
REDIS_DIR="$WORK/redis"
KV_DATA="$WORK/kvrocks"
KV_LOG="$WORK/kvrocks-log"
DATA="$WORK/cvat-data"
mkdir -p "$PGDATA" "$REDIS_DIR" "$KV_DATA" "$KV_LOG" "$DATA" "$WORK/logs"

PGPORT=25432
REDISPORT=26379
KVPORT=26666
OPAPORT=28181
APIPORT=27000
UIPORT=28080

export DATUMARO_HEADLESS=1
export DJANGO_SETTINGS_MODULE=cvat_desktop_settings
export PYTHONPATH="$ROOT/desktop/macos/runtime:$ROOT"
export CVAT_BASE_DIR="$DATA"
export CVAT_HOST="127.0.0.1:$UIPORT"
export CVAT_BASE_URL="http://127.0.0.1:$UIPORT"
export CVAT_POSTGRES_HOST=127.0.0.1
export CVAT_POSTGRES_PORT="$PGPORT"
export CVAT_POSTGRES_DBNAME=cvat
export CVAT_POSTGRES_USER=cvat
export CVAT_POSTGRES_PASSWORD=""
export CVAT_REDIS_INMEM_HOST=127.0.0.1
export CVAT_REDIS_INMEM_PORT="$REDISPORT"
export CVAT_REDIS_ONDISK_HOST=127.0.0.1
export CVAT_REDIS_ONDISK_PORT="$KVPORT"
export CVAT_OPA_URL="http://127.0.0.1:$OPAPORT"
export CVAT_ANALYTICS=0

PG_BIN="$(brew --prefix postgresql@15)/bin"
KVROCKS_BIN="$RUNNER_TEMP/kvrocks/build/kvrocks"
OPA_BIN="$(command -v opa)"
PYTHON="${PYTHON:-python}"

PIDS=()
PG_STARTED=0
cleanup() {
  set +e
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  sleep 1
  for pid in "${PIDS[@]}"; do
    kill -9 "$pid" 2>/dev/null
  done
  if [[ "$PG_STARTED" == "1" ]]; then
    pg_ctl -D "$PGDATA" -m fast -w stop
  fi
}
trap cleanup EXIT

wait_port() {
  local port="$1"
  for attempt in {1..60}; do
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for port $port" >&2
  return 1
}

echo "::group::Start native PostgreSQL"
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  initdb -D "$PGDATA" -U cvat -A trust --encoding=UTF8
fi
pg_ctl -D "$PGDATA" -l "$WORK/logs/postgres.log" -o "-h 127.0.0.1 -p $PGPORT" -w start
PG_STARTED=1
createdb -h 127.0.0.1 -p "$PGPORT" -U cvat cvat
pg_isready -h 127.0.0.1 -p "$PGPORT"
echo "::endgroup::"

echo "::group::Start Redis, Kvrocks and OPA"
redis-server --bind 127.0.0.1 --port "$REDISPORT" --dir "$REDIS_DIR" --save "" --appendonly no >"$WORK/logs/redis.log" 2>&1 &
PIDS+=("$!")
cat > "$WORK/kvrocks.conf" <<EOF
bind 127.0.0.1
port $KVPORT
daemonize no
log-dir $KV_LOG
dir $KV_DATA
EOF
"$KVROCKS_BIN" -c "$WORK/kvrocks.conf" >"$WORK/logs/kvrocks.log" 2>&1 &
PIDS+=("$!")
"$OPA_BIN" run --server --addr="127.0.0.1:$OPAPORT" --log-level=error \
  --set=services.cvat.url="http://127.0.0.1:$APIPORT" \
  --set=bundles.cvat.service=cvat \
  --set=bundles.cvat.resource=/api/auth/rules \
  --set=bundles.cvat.polling.min_delay_seconds=5 \
  --set=bundles.cvat.polling.max_delay_seconds=15 \
  >"$WORK/logs/opa.log" 2>&1 &
PIDS+=("$!")
wait_port "$REDISPORT"
wait_port "$KVPORT"
wait_port "$OPAPORT"
redis-cli -h 127.0.0.1 -p "$REDISPORT" ping | grep -q PONG
redis-cli -h 127.0.0.1 -p "$KVPORT" ping | grep -q PONG
curl --fail --silent "http://127.0.0.1:$OPAPORT/health" >/dev/null
echo "::endgroup::"

echo "::group::Run CVAT database and Redis migrations"
"$PYTHON" manage.py migrate --noinput
"$PYTHON" manage.py migrateredis
"$PYTHON" manage.py syncperiodicjobs
"$PYTHON" manage.py collectstatic --noinput
"$PYTHON" manage.py check
echo "::endgroup::"

echo "::group::Start CVAT API and RQ processes"
"$PYTHON" -m uvicorn cvat.asgi:application --host 127.0.0.1 --port "$APIPORT" --workers 1 >"$WORK/logs/api.log" 2>&1 &
PIDS+=("$!")
wait_port "$APIPORT"
for attempt in {1..60}; do
  if curl --fail --silent "http://127.0.0.1:$APIPORT/api/server/about" >"$WORK/about.json"; then
    break
  fi
  sleep 1
done
"$PYTHON" -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict); print("CVAT API about endpoint:", d.get("version", "available"))' "$WORK/about.json"

"$PYTHON" manage.py rqworker -v 3 import export annotation webhooks notifications quality_reports cleaning chunks consensus >"$WORK/logs/worker.log" 2>&1 &
WORKER_PID=$!
PIDS+=("$WORKER_PID")
"$PYTHON" rqscheduler.py --host 127.0.0.1 --port "$REDISPORT" --password "" -i 30 >"$WORK/logs/scheduler.log" 2>&1 &
SCHEDULER_PID=$!
PIDS+=("$SCHEDULER_PID")
sleep 3
kill -0 "$WORKER_PID"
kill -0 "$SCHEDULER_PID"
echo "::endgroup::"

echo "::group::Test Electron UI/API local proxy"
node --check desktop/macos/app/main.cjs
node --check desktop/macos/app/preload.cjs
node --check desktop/macos/app/runtime.cjs
node --check desktop/macos/app/server.cjs
node -e 'require("./desktop/macos/app/server.cjs").createCvatServer({frontendDir: "cvat-ui/dist", staticDir: process.env.CVAT_BASE_DIR + "/static", backendUrl: "http://127.0.0.1:27000", port: 28080}).then(() => console.log("Local CVAT UI proxy ready"));' >"$WORK/logs/ui-proxy.log" 2>&1 &
PIDS+=("$!")
wait_port "$UIPORT"
curl --fail --silent "http://127.0.0.1:$UIPORT/" | grep -qi "<html"
curl --fail --silent "http://127.0.0.1:$UIPORT/api/server/about" >"$WORK/about-via-proxy.json"
"$PYTHON" -c 'import json,sys; json.load(open(sys.argv[1])); print("CVAT API through local desktop proxy: OK")' "$WORK/about-via-proxy.json"
echo "::endgroup::"
