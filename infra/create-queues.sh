#!/bin/sh
set -eu
ENDPOINT="http://aws:4566"
aws_sqs() { aws --endpoint-url "$ENDPOINT" sqs "$@"; }

echo "Waiting for SQS endpoint..."
until aws_sqs list-queues >/dev/null 2>&1; do sleep 1; done

DLQ_URL=$(aws_sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)
DLQ_ARN=$(aws_sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/main-attrs.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
JSON
aws_sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/main-attrs.json >/dev/null

echo "Queues ready:"
aws_sqs list-queues --output text
