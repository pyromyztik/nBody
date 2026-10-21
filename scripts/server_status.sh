#!/usr/bin/env bash
# server_status.sh - Display current server status, uptime, resource usage, and log overview.

set -u

# Resolve actual directory even if run through symlink in /usr/local/bin
TARGET="${BASH_SOURCE[0]}"
while [ -L "$TARGET" ]; do
    DIR="$(cd -P "$(dirname "$TARGET")" >/dev/null 2>&1 && pwd)"
    TARGET="$(readlink "$TARGET")"
    [[ $TARGET != /* ]] && TARGET="$DIR/$TARGET"
done
SCRIPT_DIR="$(cd -P "$(dirname "$TARGET")" >/dev/null 2>&1 && pwd)"
NBODY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ ! -d "$NBODY_DIR/logs" ] && [ -d "/home/ubuntu/nBody/logs" ] && NBODY_DIR="/home/ubuntu/nBody"
LOG_DIR="$NBODY_DIR/logs"
STATS_JSON="$LOG_DIR/total_uptime.json"

echo "================================================================================"
echo "                 N-BODY SIMULATION SERVER & HOST STATUS                         "
echo "================================================================================"

# 1. Process Status
PID=$(pgrep -f "nbody_ws" || true)
if [ -n "$PID" ]; then
    PROC_MEM=$(ps -o rss= -p "$PID" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
    PROC_CPU=$(ps -o %cpu= -p "$PID" 2>/dev/null | tr -d ' ')
    echo "Server Process:       ACTIVE (PID: $PID)"
    echo "Process CPU:          ${PROC_CPU}%"
    echo "Process RSS Memory:   ${PROC_MEM}"
else
    echo "Server Process:       STOPPED"
fi

# 2. Server Uptime & Run Metrics
if [ -f "$STATS_JSON" ]; then
    echo "--------------------------------------------------------------------------------"
    echo "SERVER UPTIME METRICS"
    echo "--------------------------------------------------------------------------------"
    STATUS=$(jq -r '.current_run_status // "UNKNOWN"' "$STATS_JSON" 2>/dev/null || echo "UNKNOWN")
    RUN_START=$(jq -r '.current_run_start_utc // "N/A"' "$STATS_JSON" 2>/dev/null || echo "N/A")
    RUN_UPTIME=$(jq -r '.current_run_uptime_human // "N/A"' "$STATS_JSON" 2>/dev/null || echo "N/A")
    RUN_SECS=$(jq -r '.current_run_uptime_seconds // 0' "$STATS_JSON" 2>/dev/null || echo 0)
    TOTAL_UPTIME=$(jq -r '.total_uptime_human // "0s"' "$STATS_JSON" 2>/dev/null || echo "0s")
    TOTAL_SECS=$(jq -r '.total_uptime_seconds // 0' "$STATS_JSON" 2>/dev/null || echo 0)
    TOTAL_RUNS=$(jq -r '.total_runs_count // 0' "$STATS_JSON" 2>/dev/null || echo 0)

    echo "Current Run Status:   $STATUS"
    echo "Current Run Started:  $RUN_START"
    echo "Current Run Duration: $RUN_UPTIME (${RUN_SECS}s)"
    echo "Total Server Runs:    $TOTAL_RUNS"
    echo "Total Server Uptime:  $TOTAL_UPTIME (${TOTAL_SECS}s)"
fi

# 3. Host / EC2 Instance Uptime
echo "--------------------------------------------------------------------------------"
echo "EC2 HOST METRICS"
echo "--------------------------------------------------------------------------------"
UPTIME_STR=$(uptime -p 2>/dev/null || uptime)
UPTIME_RAW=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
echo "EC2 Host Uptime:      $UPTIME_STR (${UPTIME_RAW}s)"

# 4. Memory Usage
FREE_OUT=$(free -m 2>/dev/null | grep Mem: || true)
if [ -n "$FREE_OUT" ]; then
    MEM_TOTAL=$(echo "$FREE_OUT" | awk '{print $2}')
    MEM_USED=$(echo "$FREE_OUT" | awk '{print $3}')
    MEM_AVAIL=$(echo "$FREE_OUT" | awk '{print $7}')
    MEM_PCT=$(awk -v u="$MEM_USED" -v t="$MEM_TOTAL" 'BEGIN {printf "%.1f%%", (u/t)*100}')
    echo "Memory Usage:         ${MEM_USED} MB / ${MEM_TOTAL} MB (${MEM_PCT}) | Available: ${MEM_AVAIL} MB"
fi

# 5. Disk Space
DISK_OUT=$(df -h / 2>/dev/null | tail -1 || true)
if [ -n "$DISK_OUT" ]; then
    DISK_SIZE=$(echo "$DISK_OUT" | awk '{print $2}')
    DISK_USED=$(echo "$DISK_OUT" | awk '{print $3}')
    DISK_AVAIL=$(echo "$DISK_OUT" | awk '{print $4}')
    DISK_PCT=$(echo "$DISK_OUT" | awk '{print $5}')
    echo "Disk Space (/):       ${DISK_USED} used / ${DISK_AVAIL} available (${DISK_SIZE} total, ${DISK_PCT} used)"
fi

# 6. Past 5 Log Runs Overview
echo "--------------------------------------------------------------------------------"
echo "STORED SERVER RUN LOGS (Past 5 Runs)"
echo "--------------------------------------------------------------------------------"
if [ -d "$LOG_DIR" ]; then
    for i in 1 2 3 4 5; do
        LOG_F="$LOG_DIR/run_$i.log"
        if [ -f "$LOG_F" ]; then
            SIZE=$(ls -lh "$LOG_F" | awk '{print $5}')
            LINES=$(wc -l < "$LOG_F")
            START_LINE=$(grep "\[RUN START\]" "$LOG_F" 2>/dev/null | head -1 || echo "")
            END_LINE=$(grep "\[RUN STOPPED\]\|\[RUN END\]" "$LOG_F" 2>/dev/null | head -1 || echo "[STILL RUNNING / ACTIVE]")
            echo "  run_$i.log: $SIZE ($LINES lines)"
            [ -n "$START_LINE" ] && echo "    Start: $START_LINE"
            [ -n "$END_LINE" ] && echo "    End:   $END_LINE"
        else
            echo "  run_$i.log: [empty / not yet populated]"
        fi
    done
else
    echo "No logs directory created yet."
fi

echo "================================================================================"
echo "Useful Commands:"
echo "  View live logs:         tail -f $LOG_DIR/run_1.log"
echo "  View cumulative uptime: cat $LOG_DIR/total_uptime.txt"
echo "  View uptime log events: tail -n 20 $LOG_DIR/uptime.log"
echo "  Restart server service: sudo systemctl restart nbody"
echo "================================================================================"
