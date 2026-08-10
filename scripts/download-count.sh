#!/usr/bin/env bash
# How many people actually downloaded Bedrock.
#
#   ./scripts/download-count.sh          # per-day breakdown
#   ./scripts/download-count.sh --total  # single number
#
# Reads the GCS usage logs through the BigQuery external table created by
# ./scripts/setup-download-tracking.sh. Nothing runs on a schedule; this scans
# the logs on demand.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
TABLE="${PROJECT}.bedrock_downloads.usage"

# A 122MB dmg arrives as many range requests and resumed transfers, so rows have
# to be summed per (day, ip, object) before anything can be called a download.
# One person pulling one file on one day counts once.
#
# "Finished" means at least 90% of the largest transfer ever seen for that
# object — which equals the real object size as soon as anyone completes one —
# and at least 50MB, so a run of early partials can't set a low bar for itself.
read -r -d '' SQL <<'EOF' || true
WITH transfers AS (
  SELECT
    DATE(TIMESTAMP_MICROS(time_micros)) AS day,
    c_ip,
    cs_object,
    SUM(sc_bytes) AS sent,
    LOGICAL_OR(REGEXP_CONTAINS(
      LOWER(IFNULL(cs_user_agent, '')),
      r'bot|crawler|spider|curl/|wget|python-requests|headless|scan'
    )) AS automated
  FROM `TABLE_REF`
  WHERE cs_method = 'GET'
    AND cs_operation LIKE 'GET_Object%'
    AND sc_status IN (200, 206)
    AND cs_object LIKE '%.dmg'
  GROUP BY day, c_ip, cs_object
),
sizes AS (
  SELECT cs_object, MAX(sent) AS full_size
  FROM transfers
  GROUP BY cs_object
),
finished AS (
  SELECT t.day, t.cs_object, t.automated
  FROM transfers t
  JOIN sizes s USING (cs_object)
  WHERE t.sent >= GREATEST(0.9 * s.full_size, 50 * 1024 * 1024)
)
SELECT
  day,
  cs_object AS object,
  COUNTIF(NOT automated) AS downloads,
  COUNTIF(automated) AS bots
FROM finished
GROUP BY day, object
ORDER BY day DESC, object
EOF

# IFNULL so an empty log bucket reads as 0 rather than NULL, which looks broken.
TOTAL_SQL="SELECT IFNULL(SUM(downloads), 0) AS downloads, IFNULL(SUM(bots), 0) AS bots FROM ($(
  echo "${SQL//\`TABLE_REF\`/\`${TABLE}\`}"
))"

if [ "${1:-}" = "--total" ]; then
  QUERY="$TOTAL_SQL"
else
  QUERY="${SQL//\`TABLE_REF\`/\`${TABLE}\`}"
fi

# bq has no --account flag; CLOUDSDK_CORE_ACCOUNT is the documented equivalent.
env "CLOUDSDK_CORE_ACCOUNT=$ACCOUNT" \
  bq --project_id "$PROJECT" --location "$REGION" \
  query --use_legacy_sql=false --format pretty "$QUERY"
