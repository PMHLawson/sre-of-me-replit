-- Additive indexes only. Apply through the reviewed migration process; no data deletion.
CREATE INDEX IF NOT EXISTS sessions_owner_active_history_idx ON public.sessions(user_id,timestamp DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_owner_deleted_history_idx ON public.sessions(user_id,deleted_at DESC,id DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS deviations_owner_history_idx ON public.deviations(user_id,start_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS organization_members_user_scope_idx ON public.organization_members(user_id,org_id);
CREATE INDEX IF NOT EXISTS audit_events_actor_history_idx ON public.audit_events(org_id,actor_user_id,occurred_at,audit_event_id);
