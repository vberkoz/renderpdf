#!/bin/bash

set -e

export AWS_PAGER=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-basil}"
STACK_NAME="${STACK_NAME:-renderpdf}"

echo "Fetching stack outputs for ${STACK_NAME} in ${REGION}..."
STACK_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null || echo "[]")

get_output() {
  local key="$1"
  echo "${STACK_OUTPUTS}" | node -e '
    const fs = require("fs");
    const outputs = JSON.parse(fs.readFileSync(0, "utf-8"));
    const match = outputs.find(o => o.OutputKey === "'"${key}"'");
    process.stdout.write(match ? match.OutputValue : "");
  '
}

API_KEYS_TABLE="${API_KEYS_TABLE:-$(get_output ApiKeysTableName)}"
USAGE_TABLE="${USAGE_TABLE:-${STACK_NAME}-usage}"
FREE_PLAN_ID="${FREE_USAGE_PLAN_ID:-$(get_output FreeUsagePlanId)}"
STARTER_PLAN_ID="${STARTER_USAGE_PLAN_ID:-$(get_output StarterUsagePlanId)}"
PRO_PLAN_ID="${PRO_USAGE_PLAN_ID:-$(get_output ProUsagePlanId)}"

if [ -z "${FREE_PLAN_ID}" ]; then
  echo "Error: FreeUsagePlanId not found in stack outputs or environment." >&2
  exit 1
fi

echo "Configuration:"
echo "  ApiKeysTable:    ${API_KEYS_TABLE}"
echo "  UsageTable:      ${USAGE_TABLE}"
echo "  FreeUsagePlan:   ${FREE_PLAN_ID}"
echo "  StarterPlan:     ${STARTER_PLAN_ID:-none}"
echo "  ProUsagePlan:    ${PRO_PLAN_ID:-none}"

echo "Scanning active API keys from ${API_KEYS_TABLE}..."
ACTIVE_KEYS=$(aws dynamodb scan \
  --table-name "${API_KEYS_TABLE}" \
  --filter-expression "isActive = :true AND begins_with(SK, :prefix)" \
  --expression-attribute-values '{":true":{"BOOL":true},":prefix":{"S":"APIKEY#"}}' \
  --region "${REGION}" \
  --profile "${PROFILE}" \
  --output json)

node -e '
const { execSync } = require("child_process");

const activeKeys = JSON.parse(process.env.ACTIVE_KEYS || "{}").Items || [];
const freePlanId = process.env.FREE_PLAN_ID;
const starterPlanId = process.env.STARTER_PLAN_ID;
const proPlanId = process.env.PRO_PLAN_ID;
const apiKeysTable = process.env.API_KEYS_TABLE;
const usageTable = process.env.USAGE_TABLE;
const region = process.env.REGION;
const profile = process.env.PROFILE;

function awsCli(cmd) {
  try {
    return execSync(`aws ${cmd} --region ${region} --profile ${profile} --output json`, { encoding: "utf-8" });
  } catch (err) {
    return null;
  }
}

console.log(`Found ${activeKeys.length} active key(s) to inspect.`);

for (const item of activeKeys) {
  const userId = item.userId?.S || "";
  const keyId = item.keyId?.S || "";
  const rawGsi = item.GSI1PK?.S || "";
  const hashedKey = rawGsi.startsWith("APIKEY#") ? rawGsi.slice(7) : rawGsi;
  let agwKeyId = item.apiGatewayKeyId?.S || "";

  if (!hashedKey || !userId) continue;

  // 1. Check user tier from usageTable
  let tier = "free";
  if (usageTable && userId) {
    const billingRaw = awsCli(`dynamodb get-item --table-name ${usageTable} --key '\''{"requestId":{"S":"BILLING#${userId}"},"timestamp":{"N":"0"}}'\''`);
    if (billingRaw) {
      try {
        const billingItem = JSON.parse(billingRaw).Item;
        const status = billingItem?.status?.S?.toLowerCase() || "";
        if (["active", "trialing", "past_due"].includes(status)) {
          tier = billingItem?.tier?.S?.toLowerCase() || "pro";
        }
      } catch (_) {}
    }
  }

  const targetPlanId = tier === "pro" ? (proPlanId || freePlanId)
    : tier === "starter" ? (starterPlanId || freePlanId)
    : freePlanId;

  const keyName = `${userId}-${keyId || hashedKey.slice(0, 8)}`;

  // 2. Ensure API Key exists in API Gateway
  if (!agwKeyId) {
    console.log(`Creating API Gateway key for ${keyName} (${tier})...`);
    const createRes = awsCli(`apigateway create-api-key --name "${keyName}" --value "${hashedKey}" --enabled`);
    if (createRes) {
      try {
        agwKeyId = JSON.parse(createRes).id;
      } catch (_) {}
    } else {
      // Lookup existing
      const getRes = awsCli(`apigateway get-api-keys --name-query "${keyName}"`);
      if (getRes) {
        try {
          const found = JSON.parse(getRes).items || [];
          if (found.length > 0) agwKeyId = found[0].id;
        } catch (_) {}
      }
    }
  }

  if (agwKeyId) {
    // 3. Associate with target Usage Plan
    console.log(`Associating key ${agwKeyId} (${keyName}) with usage plan ${targetPlanId}...`);
    awsCli(`apigateway create-usage-plan-key --usage-plan-id "${targetPlanId}" --key-id "${agwKeyId}" --key-type "API_KEY"`);

    // 4. Update DynamoDB item with apiGatewayKeyId
    if (item.PK?.S && item.SK?.S && !item.apiGatewayKeyId?.S) {
      awsCli(`dynamodb update-item --table-name ${apiKeysTable} --key '\''{"PK":{"S":"${item.PK.S}"},"SK":{"S":"${item.SK.S}"}}'\'' --update-expression "SET apiGatewayKeyId = :agw" --expression-attribute-values '\''{":agw":{"S":"${agwKeyId}"}}'\''`);
    }
  }
}
console.log("API key usage plan sync completed.");
'
