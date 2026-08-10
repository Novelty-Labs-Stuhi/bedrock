#!/usr/bin/env bash
# One-time setup for download counting. Run it yourself — it needs the gmail
# account, the only one with write access to the project.
#
#   ./scripts/setup-download-tracking.sh
#
# Safe to re-run: every step checks for what it is about to create.
#
# The site only 302s to GCS, so nothing of ours runs while a dmg transfers and
# the Cloud Run request logs can only ever show clicks. GCS usage logs are the
# record of downloads that actually finished. This turns them on and puts a
# BigQuery external table over them — no ETL, no copy of the data, nothing on a
# schedule. Query it with ./scripts/download-count.sh.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
DL_BUCKET="gs://getbedrock-downloads"
LOG_BUCKET="gs://getbedrock-download-logs"
LOG_PREFIX="dl"
DATASET="bedrock_downloads"
TABLE="usage"

GC=(gcloud --account "$ACCOUNT" --project "$PROJECT")
# bq has no --account flag; CLOUDSDK_CORE_ACCOUNT is the documented equivalent.
BQ=(env "CLOUDSDK_CORE_ACCOUNT=$ACCOUNT" bq --project_id "$PROJECT" --location "$REGION")

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
"${GC[@]}" services enable storage.googleapis.com bigquery.googleapis.com

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
# Must sit in the same region as the bucket for an external table to read it.
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

echo "==> Letting CI publish the count the site shows"
# deploy-site.yml runs scripts/publish-count.sh, so the GitHub Actions identity
# needs to run a query and read the external table. Storage write it already has.
CI_SA="github-actions-bedrock@${PROJECT}.iam.gserviceaccount.com"
for role in roles/bigquery.jobUser roles/bigquery.dataViewer; do
  retry "${GC[@]}" projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:${CI_SA}" --role "$role" >/dev/null
  echo "    $role"
done

echo
echo "Done. Usage logs start arriving within the hour; nothing before now is"
echo "recoverable. Read the count with:"
echo "  ./scripts/download-count.sh"
