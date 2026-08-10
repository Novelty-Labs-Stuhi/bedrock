#!/usr/bin/env python3
"""Publish the download count the site shows, from Cloud Monitoring.

    ./scripts/publish-count.py                     # advance from the last run
    ./scripts/publish-count.py --backfill          # recount all retained history
    ./scripts/publish-count.py --backfill 2026-08-01T00:00:00Z
    ./scripts/publish-count.py --dry-run           # print, upload nothing

Why Monitoring rather than the GCS usage logs: the logs are a batch pipeline —
documented as typically 15 minutes after the hour, guaranteed only "at least
every six hours", and explicitly not guaranteed for timeliness or completeness.
Monitoring has the same bytes within a minute or two. scripts/download-count.sh
still reads the logs and stays the accurate cross-check.

What this trades away is real: GCS metrics carry no object or client labels, so
there is no per-IP dedup and no way to separate bots. The count is bytes served
divided by the size of the dmg, which means one person downloading twice counts
twice, and two people each abandoning halfway count as one download between them.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

PROJECT = "cleveland-464404-m0"
BUCKET = "getbedrock-downloads"
DEST = f"gs://{BUCKET}/counts.json"
LATEST_DMG = f"gs://{BUCKET}/Bedrock-latest-arm64.dmg"

# Run by hand this uses the gmail account, the only one with write access. CI has
# no such login — the workload identity credentials are ambient — so the workflow
# sets GCLOUD_ACCOUNT to empty to leave the account unpinned.
ACCOUNT = os.environ.get("GCLOUD_ACCOUNT", "arseniichistiakov@gmail.com")

METRIC = "storage.googleapis.com/network/sent_bytes_count"
FILTER = (
    f'metric.type="{METRIC}"'
    f' AND resource.label.bucket_name="{BUCKET}"'
    ' AND metric.label.method="ReadObject"'
    ' AND metric.label.response_code="OK"'
)

# Points are aligned into 5 minute buckets: small enough that the count moves
# soon after a download, large enough that backfilling weeks stays a few pages.
ALIGN_SECONDS = 300

# Monitoring can accept a sample slightly after the fact. The window always stops
# short of now by this much, so an arriving-late point is not skipped past by the
# watermark it would have landed behind.
LAG_SECONDS = 300

# Nothing existed in the bucket before this, so a backfill from here is complete
# as far as Monitoring's retention reaches.
DEFAULT_START = "2026-08-01T00:00:00Z"


def gcloud(args, check=True):
    cmd = ["gcloud"] + args
    if ACCOUNT:
        cmd += ["--account", ACCOUNT]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        sys.exit(f"gcloud {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc


def access_token():
    return gcloud(["auth", "print-access-token"]).stdout.strip()


def floor_to_align(when):
    epoch = int(when.timestamp())
    return datetime.fromtimestamp(epoch - epoch % ALIGN_SECONDS, timezone.utc)


def iso(when):
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def dmg_size():
    """Size of the installer, used as the divisor.

    Falls back to the largest .dmg in the bucket, so this still works if the
    stable alias is ever renamed or missing.
    """
    proc = gcloud(["storage", "objects", "describe", LATEST_DMG, "--format=value(size)"], check=False)
    if proc.returncode == 0 and proc.stdout.strip().isdigit():
        return int(proc.stdout.strip())

    listing = gcloud(["storage", "ls", "-l", f"gs://{BUCKET}/*.dmg"]).stdout
    sizes = [int(p[0]) for line in listing.splitlines() if (p := line.split()) and p[0].isdigit()]
    if not sizes:
        sys.exit("no .dmg found in the bucket, so there is no divisor to count with")
    return max(sizes)


def bytes_sent(token, start, end):
    """Total bytes GCS sent for object reads in [start, end)."""
    base = f"https://monitoring.googleapis.com/v3/projects/{PROJECT}/timeSeries"
    params = {
        "filter": FILTER,
        "interval.startTime": iso(start),
        "interval.endTime": iso(end),
        "aggregation.alignmentPeriod": f"{ALIGN_SECONDS}s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
    }

    total = 0
    points = 0
    page = None
    while True:
        query = dict(params)
        if page:
            query["pageToken"] = page
        request = urllib.request.Request(
            f"{base}?{urllib.parse.urlencode(query)}",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.load(response)
        except urllib.error.HTTPError as err:
            sys.exit(f"Monitoring API returned {err.code}:\n{err.read().decode('utf-8', 'replace')}")

        for series in body.get("timeSeries", []):
            for point in series.get("points", []):
                total += int(point["value"]["int64Value"])
                points += 1

        page = body.get("nextPageToken")
        if not page:
            return total, points


def load_state():
    proc = gcloud(["storage", "cat", DEST], check=False)
    if proc.returncode != 0:
        return None
    try:
        return json.loads(proc.stdout)
    except ValueError:
        # A corrupt or hand-edited counts.json rebuilds from a backfill rather
        # than wedging every future run.
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--backfill",
        nargs="?",
        const=DEFAULT_START,
        help="recount from this RFC3339 time instead of resuming (default %(default)s)",
        default=None,
    )
    parser.add_argument("--dry-run", action="store_true", help="print the payload, upload nothing")
    args = parser.parse_args()

    end = floor_to_align(datetime.now(timezone.utc) - timedelta(seconds=LAG_SECONDS))

    state = None if args.backfill else load_state()
    if state and state.get("watermark"):
        start = datetime.strptime(state["watermark"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        carried_bytes = int(state.get("bytes", 0))
        carried_exact = float(state.get("downloads_exact", 0.0))
        since = state.get("since", state["watermark"])
    else:
        start = floor_to_align(
            datetime.strptime(args.backfill or DEFAULT_START, "%Y-%m-%dT%H:%M:%SZ").replace(
                tzinfo=timezone.utc
            )
        )
        carried_bytes = 0
        carried_exact = 0.0
        since = iso(start)
        print(f"==> Backfilling from {since}")

    if start >= end:
        print(f"==> Nothing new: watermark {iso(start)} is already at or past {iso(end)}")
        return

    size = dmg_size()
    print(f"==> Querying {iso(start)} .. {iso(end)}  (dmg {size:,} bytes)")
    fresh, points = bytes_sent(access_token(), start, end)

    # Accumulated as a fraction rather than dividing the running byte total: the
    # dmg changes size between releases, and re-dividing all of history by the
    # newest size would make the published count jump on every release.
    total_bytes = carried_bytes + fresh
    total_exact = carried_exact + fresh / size

    payload = {
        "total": max(0, round(total_exact)),
        "downloads_exact": round(total_exact, 3),
        "bytes": total_bytes,
        "dmg_size": size,
        "since": since,
        "watermark": iso(end),
        "source": "cloud-monitoring",
        "generated": iso(datetime.now(timezone.utc)),
    }
    print(f"    {points} points, {fresh:,} new bytes (~{fresh / size:.2f} dmg)")
    print(f"    {json.dumps(payload)}")

    if args.dry_run:
        print("==> Dry run, nothing uploaded")
        return

    tmp = "counts.json.tmp"
    with open(tmp, "w") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    try:
        print(f"==> Uploading to {DEST}")
        gcloud([
            "storage", "cp", tmp, DEST,
            "--content-type", "application/json",
            "--cache-control", "public, max-age=120",
            "--quiet",
        ])
    finally:
        os.unlink(tmp)


if __name__ == "__main__":
    main()
