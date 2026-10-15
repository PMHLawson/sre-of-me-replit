-- SOMR-468: explicit reviewed additive DDL, applied only after backup/identity checks.
-- This is deliberately outside the existing migration journal; no runtime auto-create.
BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
CREATE TABLE public.owner_write_resource_budgets (
  owner_user_id text PRIMARY KEY REFERENCES public.users(id),
  minute_started_at timestamptz NOT NULL DEFAULT date_trunc('minute',clock_timestamp()),
  minute_count integer NOT NULL DEFAULT 0 CHECK (minute_count BETWEEN 0 AND 30),
  day_date date NOT NULL DEFAULT ((clock_timestamp() AT TIME ZONE 'UTC')::date),
  day_count integer NOT NULL DEFAULT 0 CHECK (day_count BETWEEN 0 AND 500),
  observed_bytes bigint NOT NULL DEFAULT 0 CHECK (observed_bytes >= 0),
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.owner_write_resource_budgets IS
  'Durable accepted external mutation counters and last logical owned JSON byte observation. No practice values, raw notes, or retention authority.';
COMMIT;
