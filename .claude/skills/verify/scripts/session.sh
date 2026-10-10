#!/usr/bin/env bash
# One isolated verification run of the Lilith AI companion: mock AI + mock Google + companion + headless Chrome.
#
#   session.sh up [game|dashboard] [--fresh]
#                                    start a run (default "game": sim.ts plays the game plugin in tmux);
#                                    --fresh skips the seeded AI config, so the setup wizard shows
#   session.sh doctor                is the current run's instance worth driving?
#   session.sh down                  stop what this run started, delete scratch data, keep evidence
#   session.sh env                   print the run's variables (eval "$(session.sh env)")
#
# A run lives in /tmp/lilith-verify/<run>/ : data/ (LILITH_AI_DATA_DIR), chrome/, pids, env, and
# evidence/ (kept by `down`). /tmp/lilith-verify/current points at the latest run; set VERIFY_RUN to
# a run dir to drive an older one. Every port is picked free, so runs can sit side by side and never
# touch a companion the user has open (that one uses the real data folder and its own port).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
COMPANION="$REPO/companion"
ROOT=/tmp/lilith-verify
RUN="${VERIFY_RUN:-$ROOT/current}"

free_port() { bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop(true)'; }
chrome_bin() { command -v google-chrome-stable || command -v google-chrome || command -v chromium || command -v chromium-browser; }
wait_for() { # wait_for <seconds> <command...>
  local deadline=$((SECONDS + $1)); shift
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || return 1
    sleep 0.3
  done
}

up() {
  local mode=game fresh=0
  for arg in "$@"; do
    case "$arg" in
      game | dashboard) mode="$arg" ;;
      --fresh) fresh=1 ;;
      *) echo "usage: session.sh up [game|dashboard] [--fresh]" >&2; exit 2 ;;
    esac
  done
  [[ -d "$COMPANION/node_modules" ]] || (cd "$COMPANION" && pnpm install --frozen-lockfile)

  local id; id="$(date +%Y%m%d-%H%M%S)-$$"
  RUN="$ROOT/$id"
  mkdir -p "$RUN/data" "$RUN/chrome" "$RUN/evidence"
  ln -sfn "$RUN" "$ROOT/current"

  local mock_port google_port cdp_port tmux_session="lilith-verify-$id"
  mock_port="$(free_port)"
  google_port="$(free_port)"
  cdp_port="$(free_port)"

  # The mock AI (OpenAI API at /v1, Ollama API at /api). "?q" asks for a search, "!" a computer tool,
  # "!b <url>" a browser run: see the header of companion/scripts/mock-llm.ts.
  nohup bun "$COMPANION/scripts/mock-llm.ts" "$mock_port" >"$RUN/mock-llm.log" 2>&1 &
  echo $! >"$RUN/mock.pid"
  wait_for 10 curl -sf "http://127.0.0.1:$mock_port/v1/models" || { echo "mock AI did not start; see $RUN/mock-llm.log" >&2; exit 1; }

  # The fake Google behind "Sign in with Google": consent page, tokens, and mail, Drive and Calendar
  # fixtures (see the header of companion/scripts/mock-google.ts and features/accounts.md).
  nohup bun "$COMPANION/scripts/mock-google.ts" "$google_port" >"$RUN/mock-google.log" 2>&1 &
  echo $! >"$RUN/google.pid"
  wait_for 10 curl -s -o /dev/null "http://127.0.0.1:$google_port/" || { echo "mock Google did not start; see $RUN/mock-google.log" >&2; exit 1; }

  # A configured AI so the dashboard skips the setup wizard, English UI, no self-updates.
  # --fresh leaves the AI unconfigured, as on a first install (features/setup-wizard.md).
  if ((fresh)); then
    echo '{ "uiLanguage": "en", "features": { "autoUpdate": false } }' >"$RUN/data/config.json"
  else
    cat >"$RUN/data/config.json" <<JSON
{ "provider": { "preset": "custom", "baseUrl": "http://127.0.0.1:$mock_port/v1", "model": "mock", "configured": true },
  "uiLanguage": "en", "features": { "autoUpdate": false } }
JSON
  fi

  # The companion, in tmux so its terminal stays drivable. "game" runs sim.ts, which spawns
  # `main.ts --bridge` and plays the plugin; "dashboard" runs `main.ts --dev` with no game.
  local cmd
  if [[ "$mode" == game ]]; then cmd="bun scripts/sim.ts en"; else cmd="bun src/main.ts --dev --no-open"; fi
  tmux new-session -d -s "$tmux_session" -x 200 -y 50 -c "$COMPANION" \
    -e "LILITH_AI_DATA_DIR=$RUN/data" -e "LILITH_AI_FAKE_DESKTOP=1" \
    -e "LILITH_AI_GOOGLE_URL=http://127.0.0.1:$google_port" -e "LILITH_GOOGLE_CLIENT_ID=mock" -e "LILITH_GOOGLE_CLIENT_SECRET=mock" \
    "$cmd; sleep 86400"
  tmux pipe-pane -t "$tmux_session" -o "cat >>'$RUN/evidence/terminal.log'"
  wait_for 30 test -s "$RUN/data/instance.json" || { echo "companion did not start; see $RUN/data/logs/lilith-ai.log" >&2; tmux capture-pane -p -t "$tmux_session" >&2; exit 1; }

  local port login companion_pid
  port="$(bun -e "console.log((await Bun.file('$RUN/data/instance.json').json()).port)")"
  login="$(bun -e "console.log((await Bun.file('$RUN/data/instance.json').json()).loginUrl)")"
  companion_pid="$(bun -e "console.log((await Bun.file('$RUN/data/instance.json').json()).pid)")"

  # Headless Chrome with a throwaway profile; cdp.ts drives it.
  nohup "$(chrome_bin)" --headless=new --remote-debugging-port="$cdp_port" --user-data-dir="$RUN/chrome" \
    --no-first-run --no-default-browser-check --window-size=1280,900 --lang=en-US about:blank \
    >"$RUN/chrome.log" 2>&1 &
  echo $! >"$RUN/chrome.pid"
  wait_for 15 curl -sf "http://127.0.0.1:$cdp_port/json/version" || { echo "Chrome did not start; see $RUN/chrome.log" >&2; exit 1; }

  cat >"$RUN/env" <<ENV
RUN_DIR=$RUN
VERIFY_MODE=$mode
LILITH_AI_DATA_DIR=$RUN/data
DASHBOARD_PORT=$port
LOGIN_URL=$login
COMPANION_PID=$companion_pid
MOCK_PORT=$mock_port
GOOGLE_PORT=$google_port
CDP_PORT=$cdp_port
TMUX_SESSION=$tmux_session
EVIDENCE=$RUN/evidence
ENV
  echo "$companion_pid" >"$RUN/companion.pid"
  cat "$RUN/env"
}

load() {
  [[ -f "$RUN/env" ]] || { echo "no run at $RUN; start one with: session.sh up" >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$RUN/env"
}

doctor() {
  load
  local ok=1 ping instance version expected_mode
  check() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then echo "ok    $label"; else echo "FAIL  $label"; ok=0; fi; }
  ping="$(curl -sf "http://127.0.0.1:$DASHBOARD_PORT/api/ping" || true)"
  instance="$(cat "$LILITH_AI_DATA_DIR/instance.json" 2>/dev/null || true)"
  version="$(bun -e "console.log(require('$COMPANION/package.json').version)")"
  [[ "$VERIFY_MODE" == game ]] && expected_mode=bridge || expected_mode=dev
  echo "      ping: ${ping:-<no answer>}"
  check "companion pid $COMPANION_PID alive" kill -0 "$COMPANION_PID"
  check "port $DASHBOARD_PORT answers as lilith-ai-companion" grep -q '"app":"lilith-ai-companion"' <<<"$ping"
  check "version is $version (companion/package.json)" grep -q "\"version\":\"$version\"" <<<"$ping"
  check "companion mode is $expected_mode" grep -q "\"mode\":\"$expected_mode\"" <<<"$ping"
  check "port belongs to this run (instance.json)" grep -q "\"pid\":$COMPANION_PID,\"port\":$DASHBOARD_PORT" <<<"$instance"
  check "mock AI on :$MOCK_PORT" curl -sf "http://127.0.0.1:$MOCK_PORT/v1/models"
  check "mock Google on :$GOOGLE_PORT" curl -s -o /dev/null "http://127.0.0.1:$GOOGLE_PORT/"
  check "headless Chrome CDP on :$CDP_PORT" curl -sf "http://127.0.0.1:$CDP_PORT/json/version"
  check "tmux session $TMUX_SESSION" tmux has-session -t "$TMUX_SESSION"
  ((ok)) || { echo "log tail:"; tail -n 15 "$LILITH_AI_DATA_DIR/logs/lilith-ai.log" 2>/dev/null; exit 1; }
}

down() {
  load
  # Keep the companion's log with the evidence before the data folder goes.
  [[ -f "$LILITH_AI_DATA_DIR/logs/lilith-ai.log" ]] && cp "$LILITH_AI_DATA_DIR/logs/lilith-ai.log" "$EVIDENCE/companion.log"
  # Ending the tmux session closes sim.ts, whose exit closes the companion's stdin (bridge mode);
  # SIGTERM covers dashboard mode. Only pids this run recorded are signalled.
  tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  for name in companion mock google chrome; do
    local pid; pid="$(cat "$RUN/$name.pid" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  sleep 1
  for name in companion mock google chrome; do
    local pid; pid="$(cat "$RUN/$name.pid" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
  rm -rf "$RUN/data" "$RUN/chrome"
  rm -f "$RUN"/*.pid
  echo "stopped run $(basename "$(readlink -f "$RUN")"); evidence kept in $EVIDENCE"
  ls -1 "$EVIDENCE"
}

case "${1:-}" in
  up) shift; up "$@" ;;
  doctor) doctor ;;
  down) down ;;
  env) load; sed 's/^/export /' "$RUN/env" ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
