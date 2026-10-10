-- A nonempty holidays table alone cannot prove a complete annual calendar.
-- Publish this marker in the same transaction as all verified holidays for a year.
CREATE TABLE holiday_calendar_years (
 year integer PRIMARY KEY CHECK(year BETWEEN 1 AND 9999),
 source text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
