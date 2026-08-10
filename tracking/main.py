"""Publish the download count the site shows.

Deployed as a Cloud Run function and driven by Cloud Scheduler. Cloud Scheduler is
the only scheduler in this project that commits to firing on time and retrying —
GitHub Actions' cron is documented as droppable under load, and it disables itself
after 60 days of repository inactivity, which would freeze the number silently.

The count is bytes GCS served divided by the size of the dmg. That is deliberately
not the same measure as scripts/download-count.sh, which reads the usage logs and
can deduplicate per IP and exclude bots. Monitoring carries no object or client
labels, so here one person downloading twice counts twice, two people abandoning
halfway count as one download between them, and reads of the stale .exe inflate
it. What it buys is latency: the bytes are visible within a minute or two instead
of waiting on a batch pipeline with no delivery guarantee.
"""

import json
import os
from datetime import datetime, timedelta, timezone

import functions_framework
from google.cloud import monitoring_v3, storage

PROJECT = os.environ.get("GCP_PROJECT", "cleveland-464404-m0")
BUCKET = os.environ.get("DOWNLOADS_BUCKET", "getbedrock-downloads")
COUNTS_OBJECT = "counts.json"
LATEST_DMG = "Bedrock-latest-arm64.dmg"

METRIC = "storage.googleapis.com/network/sent_bytes_count"
FILTER = (
    f'metric.type="{METRIC}"'
    f' AND resource.label.bucket_name="{BUCKET}"'
    ' AND metric.label.method="ReadObject"'
    ' AND metric.label.response_code="OK"'
)

# 60s buckets so the count moves within a few minutes of a download.
ALIGN_SECONDS = 60

# Monitoring accepts a sample slightly after the fact. The window always stops
# short of now by this much, so a late-arriving point is not skipped past by the
# watermark that would have sat in front of it.
LAG_SECONDS = 180

# Nothing was in the bucket before this, so a backfill from here is complete as
# far as Monitoring's retention reaches (about six weeks).
DEFAULT_START = "2026-08-01T00:00:00Z"

ISO = "%Y-%m-%dT%H:%M:%SZ"


def _floor(when):
    epoch = int(when.timestamp())
    return datetime.fromtimestamp(epoch - epoch % ALIGN_SECONDS, timezone.utc)


def _parse(text):
    return datetime.strptime(text, ISO).replace(tzinfo=timezone.utc)


def _bytes_sent(start, end):
    client = monitoring_v3.MetricServiceClient()
    request = monitoring_v3.ListTimeSeriesRequest(
        name=f"projects/{PROJECT}",
        filter=FILTER,
        interval=monitoring_v3.TimeInterval(
            start_time={"seconds": int(start.timestamp())},
            end_time={"seconds": int(end.timestamp())},
        ),
        view=monitoring_v3.ListTimeSeriesRequest.TimeSeriesView.FULL,
        aggregation=monitoring_v3.Aggregation(
            alignment_period={"seconds": ALIGN_SECONDS},
            per_series_aligner=monitoring_v3.Aggregation.Aligner.ALIGN_SUM,
            cross_series_reducer=monitoring_v3.Aggregation.Reducer.REDUCE_SUM,
        ),
    )

    total = 0
    points = 0
    # The client paginates for us.
    for series in client.list_time_series(request=request):
        for point in series.points:
            total += int(point.value.int64_value)
            points += 1
    return total, points


def _dmg_size(bucket):
    """Size of the installer, used as the divisor.

    Falls back to the largest .dmg present, so this keeps working if the stable
    alias is ever renamed or missing.
    """
    blob = bucket.get_blob(LATEST_DMG)
    if blob and blob.size:
        return blob.size

    sizes = [b.size for b in bucket.list_blobs() if b.name.endswith(".dmg") and b.size]
    if not sizes:
        raise RuntimeError("no .dmg in the bucket, so there is no divisor to count with")
    return max(sizes)


def _load_state(bucket):
    blob = bucket.get_blob(COUNTS_OBJECT)
    if not blob:
        return None
    try:
        return json.loads(blob.download_as_bytes())
    except (ValueError, UnicodeDecodeError):
        # A corrupt or hand-edited counts.json rebuilds from a backfill rather
        # than wedging every run after it.
        return None


def refresh_count(backfill=None):
    client = storage.Client(project=PROJECT)
    bucket = client.bucket(BUCKET)

    end = _floor(datetime.now(timezone.utc) - timedelta(seconds=LAG_SECONDS))

    state = None if backfill else _load_state(bucket)
    if state and state.get("watermark"):
        start = _parse(state["watermark"])
        carried_bytes = int(state.get("bytes", 0))
        carried_exact = float(state.get("downloads_exact", 0.0))
        since = state.get("since", state["watermark"])
    else:
        start = _floor(_parse(backfill or DEFAULT_START))
        carried_bytes = 0
        carried_exact = 0.0
        since = start.strftime(ISO)

    if start >= end:
        return {"skipped": "watermark already current", "watermark": start.strftime(ISO)}

    size = _dmg_size(bucket)
    fresh, points = _bytes_sent(start, end)

    # Accumulated as a fraction rather than dividing a running byte total: the dmg
    # changes size between releases, and re-dividing all of history by the newest
    # size would make the published count jump on every release.
    total_bytes = carried_bytes + fresh
    total_exact = carried_exact + fresh / size

    payload = {
        "total": max(0, round(total_exact)),
        "downloads_exact": round(total_exact, 3),
        "bytes": total_bytes,
        "dmg_size": size,
        "since": since,
        "watermark": end.strftime(ISO),
        "source": "cloud-monitoring",
        "generated": datetime.now(timezone.utc).strftime(ISO),
    }

    # Short cache, set before the upload so it lands in the same request. Doing it
    # as a second patch leaves a window where the object is public with no
    # cache-control, and anything fetching in that window caches it under GCS's
    # much longer default — which is how a stale copy outlives several rewrites.
    blob = bucket.blob(COUNTS_OBJECT)
    blob.cache_control = "public, max-age=120"
    blob.upload_from_string(
        json.dumps(payload, indent=2) + "\n",
        content_type="application/json",
    )

    payload["window"] = f"{start.strftime(ISO)}..{end.strftime(ISO)}"
    payload["new_bytes"] = fresh
    payload["points"] = points
    return payload


@functions_framework.http
def refresh(request):
    """HTTP entry point. Optional JSON body: {"backfill": "2026-08-01T00:00:00Z"}."""
    backfill = None
    body = request.get_json(silent=True) or {}
    if isinstance(body, dict):
        backfill = body.get("backfill") or None

    try:
        result = refresh_count(backfill)
    except Exception as err:  # surfaced to Scheduler as a failure so it retries
        print(f"refresh failed: {err!r}")
        return (json.dumps({"error": str(err)}), 500, {"Content-Type": "application/json"})

    print(json.dumps(result))
    return (json.dumps(result), 200, {"Content-Type": "application/json"})
