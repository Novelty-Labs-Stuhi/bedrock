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
