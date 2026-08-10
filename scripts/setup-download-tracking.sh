#!/usr/bin/env bash
# One-time setup for download counting. Run it yourself — it needs the gmail
# account, the only one with write access to the project.
#
#   ./scripts/setup-download-tracking.sh
#
# Safe to re-run: every step checks for what it is about to create.
#
# There are two counts here, measuring different things on purpose.
#
#   The page count comes from Cloud Monitoring: bytes GCS served divided by the
#   size of the dmg. Visible within a minute or two, but Monitoring carries no
#   object or client labels, so it cannot deduplicate per IP or exclude bots.
#   A Cloud Run function computes it and Cloud Scheduler drives it.
#
#   The accurate count comes from the bucket's usage logs through a BigQuery
#   external table — it deduplicates per (day, IP, object) and separates bots,
#   but the logs are a batch pipeline with no delivery guarantee. Read it with
#   ./scripts/download-count.sh.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
# Cloud Scheduler has no europe-north1 presence, so the trigger lives one region
# over and calls across regions. Nothing about that is load-bearing.
SCHEDULER_REGION="europe-west1"
DL_BUCKET="gs://getbedrock-downloads"
LOG_BUCKET="gs://getbedrock-download-logs"
LOG_PREFIX="dl"
DATASET="bedrock_downloads"
TABLE="usage"
FUNCTION="bedrock-download-counter"
SA_NAME="bedrock-download-counter"
SCHEDULE="*/2 * * * *"

SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
GC=(gcloud --account "$ACCOUNT" --project "$PROJECT")
# bq has no --account flag; CLOUDSDK_CORE_ACCOUNT is the documented equivalent.
BQ=(env "CLOUDSDK_CORE_ACCOUNT=$ACCOUNT" bq --quiet --headless --project_id "$PROJECT" --location "$REGION")
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# IAM is eventually consistent — a fresh service account 400s as "does not exist"
# for a few seconds after it is created.
retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 12 ]; then
      echo "    giving up after $n attempts" >&2
      return 1
    fi
    echo "    not visible yet, retrying in 5s ($n/12)" >&2
    sleep 5
  done
}

echo "==> Enabling APIs"
"${GC[@]}" services enable \
  storage.googleapis.com \
  bigquery.googleapis.com \
  monitoring.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  run.googleapis.com

echo "==> Log bucket"
if "${GC[@]}" storage buckets describe "$LOG_BUCKET" >/dev/null 2>&1; then
  echo "    already exists"
else
  "${GC[@]}" storage buckets create "$LOG_BUCKET" \
    --location "$REGION" --uniform-bucket-level-access
fi

# Usage logs are delivered by a Google-owned group, not by us. No lifecycle rule
# here on purpose: these CSVs are the durable record, unlike Cloud Run request
# logs which age out after 30 days.
echo "==> Letting GCS deliver usage logs into it"
retry "${GC[@]}" storage buckets add-iam-policy-binding "$LOG_BUCKET" \
  --member "group:cloud-storage-analytics@google.com" \
  --role roles/storage.objectCreator >/dev/null

echo "==> Turning on usage logging for $DL_BUCKET"
"${GC[@]}" storage buckets update "$DL_BUCKET" \
  --log-bucket "$LOG_BUCKET" --log-object-prefix "$LOG_PREFIX" >/dev/null

echo "==> BigQuery dataset"
if "${BQ[@]}" show "${DATASET}" >/dev/null 2>&1; then
  echo "    already exists"
else
  "${BQ[@]}" mk --dataset --description "Bedrock download tracking" "${DATASET}"
fi

echo "==> External table over the usage logs"
# Schema is the documented v0 usage-log layout. CREATE OR REPLACE keeps this
# idempotent; the table holds no data, it just points at the CSV glob, so new
# logs show up in queries the moment GCS delivers them.
"${BQ[@]}" query --use_legacy_sql=false --format none \
  "CREATE OR REPLACE EXTERNAL TABLE \`${PROJECT}.${DATASET}.${TABLE}\` (
     time_micros INT64,
     c_ip STRING,
     c_ip_type INT64,
     c_ip_region STRING,
     cs_method STRING,
     cs_uri STRING,
     sc_status INT64,
     cs_bytes INT64,
     sc_bytes INT64,
     time_taken_micros INT64,
     cs_host STRING,
     cs_referer STRING,
     cs_user_agent STRING,
     s_request_id STRING,
     cs_operation STRING,
     cs_bucket STRING,
     cs_object STRING
   )
   OPTIONS (
     format = 'CSV',
     skip_leading_rows = 1,
     ignore_unknown_values = true,
     uris = ['${LOG_BUCKET}/${LOG_PREFIX}_usage_*']
   )"

echo "==> Service account for the counter"
if "${GC[@]}" iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  echo "    already exists"
else
  "${GC[@]}" iam service-accounts create "$SA_NAME" --display-name "Bedrock download counter"
  retry "${GC[@]}" iam service-accounts describe "$SA_EMAIL" >/dev/null
fi

# Reads the bytes-served metric, and reads/writes counts.json in the bucket.
retry "${GC[@]}" projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/monitoring.viewer >/dev/null
retry "${GC[@]}" storage buckets add-iam-policy-binding "$DL_BUCKET" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/storage.objectAdmin >/dev/null
echo "    granted monitoring.viewer and object access"

echo "==> Deploying the counter function"
# Deployed from source: gcloud builds the image, so there is no Dockerfile to
# maintain here — but it is still a Cloud Build run and takes a couple of minutes.
"${GC[@]}" functions deploy "$FUNCTION" \
  --gen2 \
  --region "$REGION" \
  --runtime python312 \
  --source "$ROOT/tracking" \
  --entry-point refresh \
  --trigger-http \
  --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" \
  --memory 256Mi \
  --timeout 120s \
  --set-env-vars "GCP_PROJECT=${PROJECT},DOWNLOADS_BUCKET=getbedrock-downloads" \
  --quiet

FUNCTION_URL="$("${GC[@]}" functions describe "$FUNCTION" --region "$REGION" \
  --format 'value(serviceConfig.uri)')"
echo "    $FUNCTION_URL"

# A gen2 function is a Cloud Run service underneath, so invoker is granted there.
echo "==> Letting the scheduler invoke it"
retry "${GC[@]}" run services add-iam-policy-binding "$FUNCTION" --region "$REGION" \
  --member "serviceAccount:${SA_EMAIL}" --role roles/run.invoker >/dev/null

echo "==> Scheduling every 2 minutes"
SCHEDULE_ARGS=(
  --location "$SCHEDULER_REGION"
  --schedule "$SCHEDULE"
  --time-zone "UTC"
  --uri "$FUNCTION_URL"
  --http-method POST
  --message-body "{}"
  --oidc-service-account-email "$SA_EMAIL"
  --oidc-token-audience "$FUNCTION_URL"
  --attempt-deadline 120s
)

# create takes --headers, update takes --update-headers. Same setting, different
# flag, and passing the wrong one is a hard error rather than a warning.
if "${GC[@]}" scheduler jobs describe "$FUNCTION" --location "$SCHEDULER_REGION" >/dev/null 2>&1; then
  "${GC[@]}" scheduler jobs update http "$FUNCTION" "${SCHEDULE_ARGS[@]}" \
    --update-headers "Content-Type=application/json" >/dev/null
  echo "    updated"
else
  "${GC[@]}" scheduler jobs create http "$FUNCTION" "${SCHEDULE_ARGS[@]}" \
    --headers "Content-Type=application/json" >/dev/null
  echo "    created"
fi

echo
echo "Done. The count refreshes every 2 minutes at"
echo "  https://storage.googleapis.com/getbedrock-downloads/counts.json"
echo
echo "Trigger it by hand or recount history with ./scripts/refresh-count.sh"
