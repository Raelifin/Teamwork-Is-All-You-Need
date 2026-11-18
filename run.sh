#!/usr/bin/env bash
# Start/stop the game server in the background.
#   ./run.sh [start|stop|restart|status|log]     (default: restart)
# Extra env (PORT, IDLE_HOURS, MODEL, ...) is passed through; see server.py.
set -euo pipefail
cd "$(dirname "$0")"
PIDFILE=.server.pid
LOGFILE=server.log

running() { [[ -f $PIDFILE ]] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; }

stop() {
  if running; then
    kill "$(cat $PIDFILE)"
    for _ in $(seq 20); do running || break; sleep 0.1; done
    echo "stopped"
  fi
  rm -f $PIDFILE
}

start() {
  if running; then echo "already running (pid $(cat $PIDFILE))"; return; fi
  setsid nohup python3 -u server.py "$@" >>"$LOGFILE" 2>&1 < /dev/null &
  echo $! > $PIDFILE
  sleep 0.5
  if running; then echo "started (pid $(cat $PIDFILE))"; tail -n 2 "$LOGFILE"
  else echo "failed to start:"; tail -n 20 "$LOGFILE"; rm -f $PIDFILE; exit 1; fi
}

cmd=${1:-restart}; shift || true
case $cmd in
  start) start "$@" ;;
  stop) stop ;;
  restart) stop; start "$@" ;;
  status) if running; then echo "running (pid $(cat $PIDFILE))"; else echo "not running"; fi ;;
  log) tail -n 50 -f "$LOGFILE" ;;
  *) echo "usage: $0 [start|stop|restart|status|log]"; exit 1 ;;
esac
