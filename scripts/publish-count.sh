#!/usr/bin/env bash
# Publish the download count for the site to read.
#
#   ./scripts/publish-count.sh
#
# Runs the same query as download-count.sh and writes the total to
# gs://getbedrock-downloads/counts.json, which the page fetches through the
# site's /counts.json route. The deploy workflow calls this, so the number
# refreshes on every site deploy; point Cloud Scheduler at it as well if you
# want it moving between deploys.
set -euo pipefail

# Run by hand it uses the gmail account, the only one with write access. In CI
# there is no such login — the workload identity credentials are ambient — so the
# workflow sets GCLOUD_ACCOUNT= (empty) to leave the account unpinned.
ACCOUNT="${GCLOUD_ACCOUNT-arseniichistiakov@gmail.com}"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
TABLE="${PROJECT}.bedrock_downloads.usage"
DEST="gs://getbedrock-downloads/counts.json"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BQ=(bq --project_id "$PROJECT" --location "$REGION")
GS=(gcloud storage)
if [ -n "$ACCOUNT" ]; then
  # bq has no --account flag; CLOUDSDK_CORE_ACCOUNT is the documented equivalent.
  BQ=(env "CLOUDSDK_CORE_ACCOUNT=$ACCOUNT" "${BQ[@]}")
  GS+=(--account "$ACCOUNT")
fi

SQL="$(sed "s|TABLE_REF|${TABLE}|g" "$ROOT/scripts/download-count.sql")"
TOTALS="SELECT IFNULL(SUM(downloads), 0) AS total, IFNULL(SUM(bots), 0) AS bots
        FROM ($SQL)"

echo "==> Querying"
ROWS="$("${BQ[@]}" query --use_legacy_sql=false --format json "$TOTALS")"

# bq returns every value as a string; the page wants real numbers.
PAYLOAD="$(ROWS="$ROWS" python3 - <<'PY'
import json, os, datetime
row = json.loads(os.environ["ROWS"])[0]
print(json.dumps({
    "total": int(row["total"]),
    "bots": int(row["bots"]),
    "generated": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds"),
}))
PY
)"
echo "    $PAYLOAD"

TMP="$(mktemp -t counts)"
trap 'rm -f "$TMP"' EXIT
printf '%s\n' "$PAYLOAD" >"$TMP"

echo "==> Uploading to $DEST"
# Short cache: the site proxies this and a stale count is worse than a request.
"${GS[@]}" cp "$TMP" "$DEST" \
  --content-type application/json \
  --cache-control "public, max-age=300" \
  --quiet
