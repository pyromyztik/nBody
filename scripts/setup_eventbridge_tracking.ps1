# setup_eventbridge_tracking.ps1
# Automates setting up Amazon EventBridge to track EC2 instance state changes into CloudWatch Logs.

$Region = "ap-south-1"
$LogGroupName = "/aws/events/ec2/instance-states"
$RuleName = "ec2-instance-state-tracker"
$InstanceId = "i-07ef40b52a8476a1a"

Write-Host "==> Verifying AWS identity..." -ForegroundColor Cyan
$callerIdentityJson = aws sts get-caller-identity --region $Region 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "AWS session is not authenticated or expired. Please run 'aws login' first." -ForegroundColor Red
    Write-Host $callerIdentityJson
    exit 1
}

$callerIdentity = $callerIdentityJson | ConvertFrom-Json
$AccountId = $callerIdentity.Account
Write-Host "Authenticated as Account: $AccountId ($($callerIdentity.Arn))" -ForegroundColor Green

# 1. Create CloudWatch Log Group
Write-Host "==> 1. Ensuring CloudWatch Log Group '$LogGroupName' exists in $Region..." -ForegroundColor Cyan
aws logs create-log-group --log-group-name $LogGroupName --region $Region 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Log group created successfully." -ForegroundColor Green
} else {
    Write-Host "Log group already exists or created." -ForegroundColor Yellow
}

# 2. Add resource policy to allow EventBridge to write to CloudWatch Logs
Write-Host "==> 2. Granting EventBridge permission to publish to CloudWatch Logs..." -ForegroundColor Cyan
$policy = @"
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TrustEventsToStoreLogEvents",
      "Effect": "Allow",
      "Principal": {
        "Service": "events.amazonaws.com"
      },
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:${Region}:${AccountId}:log-group:${LogGroupName}:*"
    }
  ]
}
"@

$cleanPolicy = $policy -replace '\r', ''
aws logs put-resource-policy --policy-name "TrustEventsToStoreLogEvents" --policy-document $cleanPolicy --region $Region
if ($LASTEXITCODE -eq 0) {
    Write-Host "Resource policy attached successfully." -ForegroundColor Green
}

# 3. Create EventBridge Rule
Write-Host "==> 3. Creating EventBridge rule '$RuleName' for instance $InstanceId..." -ForegroundColor Cyan
$eventPattern = @"
{
  "source": ["aws.ec2"],
  "detail-type": ["EC2 Instance State-change Notification"],
  "detail": {
    "instance-id": ["$InstanceId"]
  }
}
"@
$cleanPattern = $eventPattern -replace '\r', ''

aws events put-rule `
    --name $RuleName `
    --event-pattern $cleanPattern `
    --state ENABLED `
    --description "Track EC2 state changes for $InstanceId into CloudWatch Logs" `
    --region $Region

if ($LASTEXITCODE -eq 0) {
    Write-Host "EventBridge rule created/updated successfully." -ForegroundColor Green
}

# 4. Target the CloudWatch Log Group
Write-Host "==> 4. Setting CloudWatch Log Group as rule target..." -ForegroundColor Cyan
$logGroupArn = "arn:aws:logs:${Region}:${AccountId}:log-group:${LogGroupName}"
aws events put-targets `
    --rule $RuleName `
    --targets "Id=1,Arn=$logGroupArn" `
    --region $Region

if ($LASTEXITCODE -eq 0) {
    Write-Host "Target added successfully." -ForegroundColor Green
    Write-Host "`nAll set! Any state transitions (pending, running, stopping, stopped, terminated)" -ForegroundColor Green
    Write-Host "for $InstanceId will now appear in CloudWatch Log Group '$LogGroupName' in real time." -ForegroundColor Green
}
