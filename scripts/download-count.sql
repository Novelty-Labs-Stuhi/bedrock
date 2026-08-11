-- Finished downloads per day, from the GCS usage logs.
--
-- TABLE_REF is substituted by the calling script so this query has exactly one
-- definition — download-count.sh prints it. Note the caller pipes this in on
-- stdin rather than passing it as an argument: a query starting with "--" is
-- parsed as a command-line flag by bq, which then crashes in its own
-- did-you-mean suggester rather than saying so.
--
-- One person pulling one file on one day counts once. A 122MB dmg arrives as
-- many range requests and resumed transfers, so bytes are summed per
-- (day, ip, object) before anything is called a download. Someone downloading
-- the same file twice in a day is therefore one download, deliberately.
WITH reads AS (
  SELECT
    DATE(TIMESTAMP_MICROS(time_micros)) AS day,
    c_ip,
    cs_object,
    sc_bytes,
    cs_user_agent
  FROM `TABLE_REF`
  WHERE cs_method = 'GET'
    AND cs_operation LIKE 'GET_Object%'
    AND sc_status IN (200, 206)
    AND cs_object LIKE '%.dmg'
),

-- The size of the object is the largest *single response* seen for it that day.
-- A completed download that was not split into ranges is exactly one response of
-- exactly the object size, so this finds the real size as soon as one person
-- downloads normally.
--
-- Taking the max of the per-person *sums* instead — which is what this used to do
-- — is wrong in a way that hides itself: one person downloading twice sets the
-- estimate to two dmg, the bar moves to 1.8 dmg, and every ordinary download that
-- day silently stops counting. That reported 1 download on a day that had 4.
--
-- Per day rather than overall because Bedrock-latest-arm64.dmg is overwritten by
-- every release, so a single size for its whole history would be the largest
-- version ever published.
sizes AS (
  SELECT day, cs_object, MAX(sc_bytes) AS full_size
  FROM reads
  GROUP BY day, cs_object
),

transfers AS (
  SELECT
    day,
    c_ip,
    cs_object,
    SUM(sc_bytes) AS sent,
    LOGICAL_OR(REGEXP_CONTAINS(
      LOWER(IFNULL(cs_user_agent, '')),
      r'bot|crawler|spider|curl/|wget|python-requests|headless|scan'
    )) AS automated
  FROM reads
  GROUP BY day, c_ip, cs_object
),

-- 90% of the object, and never less than 50MB, so a day seen only through
-- range requests cannot set a low bar for itself.
finished AS (
  SELECT t.day, t.cs_object, t.automated
  FROM transfers t
  JOIN sizes s USING (day, cs_object)
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
