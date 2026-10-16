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
-- Owner-leading indexes cover every historical row, including soft-deleted data.
-- They prevent each owner's aggregate measurement from scanning other tenants.
CREATE INDEX somr468_sessions_owner_bytes_idx ON public.sessions(user_id);
CREATE INDEX somr468_session_edits_owner_bytes_idx ON public.session_edits(user_id);
CREATE INDEX somr468_deviations_owner_bytes_idx ON public.deviations(user_id);
CREATE INDEX somr468_domains_owner_bytes_idx ON public.domains(owner_user_id);
CREATE INDEX somr468_policy_versions_owner_bytes_idx ON public.policy_versions(owner_user_id);
CREATE INDEX somr468_dimension_definitions_owner_bytes_idx ON public.dimension_definitions(owner_user_id);
CREATE INDEX somr468_observations_owner_bytes_idx ON public.observations(owner_user_id);
CREATE INDEX somr468_evaluation_results_owner_bytes_idx ON public.evaluation_results(owner_user_id);
CREATE INDEX somr468_deviations_v2_owner_bytes_idx ON public.deviations_v2(owner_user_id);
CREATE INDEX somr468_deviation_domains_owner_bytes_idx ON public.deviation_domains(owner_user_id);
CREATE INDEX somr468_source_bindings_owner_bytes_idx ON public.source_bindings(owner_user_id);
CREATE INDEX somr468_audit_events_owner_bytes_idx ON public.audit_events(actor_user_id) WHERE actor_kind='user';
COMMIT;
