#!/usr/bin/env bash
# run_server.sh - N-Body Simulation Server Launcher & Log/Uptime Manager
# Manages rotation of the past 5 runs of server logs and cumulative total uptime tracking.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NBODY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$NBODY_DIR/logs"
BIN="$NBODY_DIR/build/nbody_ws"
MAX_RUNS=5

# Ensure log directory exists
mkdir -p "$LOG_DIR"

RUNS_FILE="$LOG_DIR/total_uptime.json"
UPTIME_LOG="$LOG_DIR/uptime.log"
HUMAN_TXT="$LOG_DIR/total_uptime.txt"

# Format seconds into readable human string
format_duration() {
    local total=$1
    local d=$(( total / 86400 ))
    local h=$(( (total % 86400) / 3600 ))
    local m=$(( (total % 3600) / 60 ))
    local s=$(( total % 60 ))
    if [ "$d" -gt 0 ]; then
        echo "${d}d ${h}h ${m}m ${s}s"
    elif [ "$h" -gt 0 ]; then
        echo "${h}h ${m}m ${s}s"
    elif [ "$m" -gt 0 ]; then
        echo "${m}m ${s}s"
    else
        echo "${s}s"
    fi
}

# Initialize JSON state file if missing
if [ ! -f "$RUNS_FILE" ]; then
    cat <<EOF > "$RUNS_FILE"
{
  "total_uptime_seconds": 0,
  "total_uptime_human": "0s",
  "total_runs_count": 0,
  "current_run_status": "STOPPED",
  "current_run_start_utc": "",
  "current_run_uptime_seconds": 0,
  "current_run_uptime_human": "0s",
  "last_updated_epoch": $(date +%s),
  "last_updated_utc": "$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
}
EOF
fi

# Rotate previous logs:
# run_5 is removed, run_4 -> run_5, run_3 -> run_4, run_2 -> run_3, run_1 -> run_2
rm -f "$LOG_DIR/run_${MAX_RUNS}.log"
for (( i=MAX_RUNS; i>=2; i-- )); do
    prev=$(( i - 1 ))
    if [ -f "$LOG_DIR/run_$prev.log" ]; then
        mv -f "$LOG_DIR/run_$prev.log" "$LOG_DIR/run_$i.log"
    fi
done

CURRENT_LOG="$LOG_DIR/run_1.log"
ln -sfn "run_1.log" "$LOG_DIR/latest.log"

START_EPOCH=$(date +%s)
START_UTC=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Read cumulative uptime seconds & previous run count from JSON state
TOTAL_UPTIME=$(python3 -c "import json; data=json.load(open('$RUNS_FILE')); print(data.get('total_uptime_seconds', 0))" 2>/dev/null || echo 0)
TOTAL_RUNS=$(python3 -c "import json; data=json.load(open('$RUNS_FILE')); print(data.get('total_runs_count', 0))" 2>/dev/null || echo 0)
TOTAL_RUNS=$(( TOTAL_RUNS + 1 ))

# State update function
update_state() {
    local status=$1
    local cur_run_sec=$2
    local cur_tot_sec=$3
    local now_epoch=$(date +%s)
    local now_utc=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

    cat <<EOF > "$RUNS_FILE.tmp"
{
  "total_uptime_seconds": $cur_tot_sec,
  "total_uptime_human": "$(format_duration $cur_tot_sec)",
  "total_runs_count": $TOTAL_RUNS,
  "current_run_status": "$status",
  "current_run_start_utc": "$START_UTC",
  "current_run_uptime_seconds": $cur_run_sec,
  "current_run_uptime_human": "$(format_duration $cur_run_sec)",
  "last_updated_epoch": $now_epoch,
  "last_updated_utc": "$now_utc"
}
EOF
    mv -f "$RUNS_FILE.tmp" "$RUNS_FILE"

    cat <<EOF > "$HUMAN_TXT.tmp"
================================================================================
N-BODY SERVER UPTIME SUMMARY
================================================================================
Server Status:        $status
Current Run Started:  $START_UTC
Current Run Uptime:   $(format_duration $cur_run_sec) (${cur_run_sec}s)
Total Server Runs:    $TOTAL_RUNS
Cumulative Uptime:    $(format_duration $cur_tot_sec) (${cur_tot_sec}s)
Last Updated (UTC):   $now_utc
Log Directory:        $LOG_DIR
Active Log:           $CURRENT_LOG (latest.log -> run_1.log)
Historical Runs:      run_1.log (current/latest) through run_${MAX_RUNS}.log (oldest)
================================================================================
EOF
    mv -f "$HUMAN_TXT.tmp" "$HUMAN_TXT"
}

# Write initial log header
cat <<EOF > "$CURRENT_LOG"
================================================================================
N-BODY SERVER RUN LOG
Run Sequence:        #$TOTAL_RUNS
Start Time (UTC):    $START_UTC
Executable:          $BIN
Working Directory:   $NBODY_DIR
Log Target:          $CURRENT_LOG (Retaining past $MAX_RUNS runs)
Prior Total Uptime:  $(format_duration $TOTAL_UPTIME) (${TOTAL_UPTIME}s)
================================================================================
EOF

echo "[$START_UTC] Run #$TOTAL_RUNS STARTED. Past cumulative uptime: $(format_duration $TOTAL_UPTIME) (${TOTAL_UPTIME}s)." >> "$UPTIME_LOG"

update_state "RUNNING" 0 $TOTAL_UPTIME

# Set up FIFO for real-time unbuffered streaming to both console & log file
FIFO="/tmp/nbody_pipe_$$"
rm -f "$FIFO"
mkfifo "$FIFO"

# Start tee logger in background
tee -a "$CURRENT_LOG" < "$FIFO" &
LOGGER_PID=$!

# Launch executable with output piped to FIFO
"$BIN" > "$FIFO" 2>&1 &
APP_PID=$!

echo "[PID] Process ID: $APP_PID" >> "$CURRENT_LOG"

# Clean signal forwarding
shutdown_handler() {
    echo "" >> "$CURRENT_LOG"
    echo "[SIGNAL] Received termination signal. Stopping nbody_ws (PID: $APP_PID)..." >> "$CURRENT_LOG"
    if kill -0 "$APP_PID" 2>/dev/null; then
        kill -TERM "$APP_PID" 2>/dev/null
    fi
}
trap shutdown_handler SIGTERM SIGINT SIGHUP

# Heartbeat loop in background: persists uptime every 15s to guarantee no lost uptime on sudden poweroff
(
    while kill -0 "$APP_PID" 2>/dev/null; do
        sleep 15
        if kill -0 "$APP_PID" 2>/dev/null; then
            NOW=$(date +%s)
            CUR_RUN=$(( NOW - START_EPOCH ))
            CUR_TOTAL=$(( TOTAL_UPTIME + CUR_RUN ))
            update_state "RUNNING" $CUR_RUN $CUR_TOTAL
        fi
    done
) &
HEARTBEAT_PID=$!

# Wait for executable to finish
wait "$APP_PID"
EXIT_CODE=$?

# Stop heartbeat
kill -9 "$HEARTBEAT_PID" 2>/dev/null || true

# Close write side of FIFO and wait for tee to exit cleanly
rm -f "$FIFO"
wait "$LOGGER_PID" 2>/dev/null || true

END_EPOCH=$(date +%s)
END_UTC=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
RUN_DURATION=$(( END_EPOCH - START_EPOCH ))
NEW_TOTAL_UPTIME=$(( TOTAL_UPTIME + RUN_DURATION ))

update_state "STOPPED" $RUN_DURATION $NEW_TOTAL_UPTIME

cat <<EOF >> "$CURRENT_LOG"

================================================================================
N-BODY SERVER RUN STOPPED
Run Sequence:        #$TOTAL_RUNS
End Time (UTC):      $END_UTC
Exit Code:           $EXIT_CODE
Run Uptime:          $(format_duration $RUN_DURATION) (${RUN_DURATION}s)
Cumulative Uptime:   $(format_duration $NEW_TOTAL_UPTIME) (${NEW_TOTAL_UPTIME}s)
Total Server Runs:   $TOTAL_RUNS
================================================================================
EOF

echo "[$END_UTC] Run #$TOTAL_RUNS STOPPED (Exit code: $EXIT_CODE). Run uptime: $(format_duration $RUN_DURATION) (${RUN_DURATION}s). Cumulative uptime: $(format_duration $NEW_TOTAL_UPTIME) (${NEW_TOTAL_UPTIME}s)." >> "$UPTIME_LOG"

exit $EXIT_CODE
