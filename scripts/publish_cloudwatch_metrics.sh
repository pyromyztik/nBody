#!/usr/bin/env bash
# publish_cloudwatch_metrics.sh - Publishes EC2 instance uptime and N-Body server uptime metrics to AWS CloudWatch.

set -u

# 1. Fetch IMDSv2 token
IMDS_TOKEN=$(curl -s -S -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" --connect-timeout 2 2>/dev/null || true)
if [ -z "$IMDS_TOKEN" ]; then
    echo "Warning: Could not obtain IMDSv2 token. Skipping CloudWatch publish." >&2
    exit 0
fi

# 2. Retrieve Instance ID and Region
INSTANCE_ID=$(curl -s -S -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id --connect-timeout 2 2>/dev/null || true)
REGION=$(curl -s -S -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/placement/region --connect-timeout 2 2>/dev/null || echo "ap-south-1")

if [ -z "$INSTANCE_ID" ]; then
    echo "Warning: Could not obtain instance ID. Skipping." >&2
    exit 0
fi

# 3. Collect EC2 Host Uptime
EC2_UPTIME_SECS=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)

# 4. Collect N-Body Server Metrics from total_uptime.json
STATS_JSON="/home/ubuntu/nBody/logs/total_uptime.json"
SERVER_TOTAL_UPTIME=0
SERVER_RUN_UPTIME=0
SERVER_RUNNING=0

if [ -f "$STATS_JSON" ]; then
    SERVER_TOTAL_UPTIME=$(jq -r '.total_uptime_seconds // 0' "$STATS_JSON" 2>/dev/null || echo 0)
    STATUS=$(jq -r '.current_run_status // "STOPPED"' "$STATS_JSON" 2>/dev/null || echo "STOPPED")
    if [ "$STATUS" = "RUNNING" ]; then
        SERVER_RUNNING=1
        SERVER_RUN_UPTIME=$(jq -r '.current_run_uptime_seconds // 0' "$STATS_JSON" 2>/dev/null || echo 0)
    fi
fi

# 5. Push metrics to AWS CloudWatch in the CWAgent namespace
# Catches error gracefully if IAM instance profile is not yet attached
PUT_OUTPUT=$(aws cloudwatch put-metric-data \
    --region "$REGION" \
    --namespace "CWAgent" \
    --metric-data \
    "MetricName=EC2InstanceUptimeSeconds,Value=$EC2_UPTIME_SECS,Unit=Seconds,Dimensions=[{Name=InstanceId,Value=$INSTANCE_ID}]" \
    "MetricName=ServerTotalUptimeSeconds,Value=$SERVER_TOTAL_UPTIME,Unit=Seconds,Dimensions=[{Name=InstanceId,Value=$INSTANCE_ID}]" \
    "MetricName=ServerCurrentRunUptimeSeconds,Value=$SERVER_RUN_UPTIME,Unit=Seconds,Dimensions=[{Name=InstanceId,Value=$INSTANCE_ID}]" \
    "MetricName=ServerProcessRunning,Value=$SERVER_RUNNING,Unit=Count,Dimensions=[{Name=InstanceId,Value=$INSTANCE_ID}]" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
    echo "$(date -u +"%Y-%m-%d %H:%M:%S UTC"): CloudWatch publish waiting for IAM role: $PUT_OUTPUT" >> /var/log/nbody_cloudwatch_publisher.log
else
    echo "$(date -u +"%Y-%m-%d %H:%M:%S UTC"): Published metrics: EC2 uptime=${EC2_UPTIME_SECS}s, Server total=${SERVER_TOTAL_UPTIME}s, Server run=${SERVER_RUN_UPTIME}s (Instance: $INSTANCE_ID)" >> /var/log/nbody_cloudwatch_publisher.log
fi

exit 0
