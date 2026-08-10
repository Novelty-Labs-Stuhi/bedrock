#!/usr/bin/env bash
# How many people actually downloaded Bedrock.
#
#   ./scripts/download-count.sh          # per-day breakdown
#   ./scripts/download-count.sh --total  # single number
#
# Reads the GCS usage logs through the BigQuery external table created by
# ./scripts/setup-download-tracking.sh. Nothing runs on a schedule; this scans
# the logs on demand, in about two seconds.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
TABLE="${PROJECT}.bedrock_downloads.usage"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SQL="$(sed "s|TABLE_REF|${TABLE}|g" "$ROOT/scripts/download-count.sql")"

if [ "${1:-}" = "--total" ]; then
  # IFNULL so an empty log bucket reads as 0 rather than NULL, which looks broken.
  SQL="SELECT IFNULL(SUM(downloads), 0) AS downloads, IFNULL(SUM(bots), 0) AS bots
       FROM ($SQL)"
fi

# bq has no --account flag; CLOUDSDK_CORE_ACCOUNT is the documented equivalent.
env "CLOUDSDK_CORE_ACCOUNT=$ACCOUNT" \
  bq --project_id "$PROJECT" --location "$REGION" \
  query --use_legacy_sql=false --format pretty "$SQL"
