-- Finished downloads per day, from the GCS usage logs.
--
-- TABLE_REF is substituted by the calling script so this query has exactly one
-- definition — download-count.sh prints it, publish-count.sh totals it for the
-- site. Do not edit one and not the other.
--
-- A 122MB dmg arrives as many range requests and resumed transfers, so rows are
-- summed per (day, ip, object) before anything is called a download: one person
-- pulling one file on one day counts once.
--
-- "Finished" means at least 90% of the largest transfer ever seen for that
-- object -- which equals the true object size as soon as anyone completes one --
-- and at least 50MB, so a run of early partials cannot set a low bar for itself.
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
-- Resolved per object *per day*, not per object. Bedrock-latest-arm64.dmg is
-- overwritten by every release, so a single size for its whole history would be
-- the largest version ever published — and after a release that shrinks the dmg,
-- every complete download of the new one would silently fall under the bar and
-- go uncounted. Per day, the bar tracks whatever was actually being served.
--
-- The trade is that a day whose only traffic is one large partial sets its own
-- low bar and counts that partial; the 50MB floor below bounds how wrong that
-- can get. A silent, permanent undercount is the worse failure.
sizes AS (
  SELECT cs_object, day, MAX(sent) AS full_size
  FROM transfers
  GROUP BY cs_object, day
),
finished AS (
  SELECT t.day, t.cs_object, t.automated
  FROM transfers t
  JOIN sizes s USING (cs_object, day)
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
