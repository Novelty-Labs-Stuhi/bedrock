#!/usr/bin/env bash
# Trigger the download counter by hand, or recount from scratch.
#
#   ./scripts/refresh-count.sh                        # advance from the last run
#   ./scripts/refresh-count.sh --backfill             # recount all retained history
#   ./scripts/refresh-count.sh --backfill 2026-08-01T00:00:00Z
#
# Cloud Scheduler already calls this function every 2 minutes; this is for
# backfilling and for checking what it returns.
set -euo pipefail

ACCOUNT="arseniichistiakov@gmail.com"
PROJECT="cleveland-464404-m0"
REGION="europe-north1"
FUNCTION="bedrock-download-counter"
DEFAULT_START="2026-08-01T00:00:00Z"

BODY='{}'
if [ "${1:-}" = "--backfill" ]; then
  BODY="{\"backfill\": \"${2:-$DEFAULT_START}\"}"
fi

# gcloud functions call handles the identity token and audience for us, which is
# the fiddly part of invoking a private gen2 function.
gcloud functions call "$FUNCTION" \
  --region "$REGION" \
  --project "$PROJECT" \
  --account "$ACCOUNT" \
  --data "$BODY"
