CREATE TABLE "audit_events" (
	"audit_event_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "audit_actor_kind" CHECK ("audit_events"."actor_kind" IN ('user','system')),
	CONSTRAINT "audit_actor_required" CHECK ("audit_events"."actor_kind"<>'user' OR "audit_events"."actor_user_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "deviation_domains" (
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"deviation_id" text NOT NULL,
	"domain_id" text NOT NULL,
	CONSTRAINT "deviation_domains_deviation_id_domain_id_pk" PRIMARY KEY("deviation_id","domain_id")
);
--> statement-breakpoint
CREATE TABLE "deviations_v2" (
	"deviation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"scope" text NOT NULL,
	"type" text NOT NULL,
	"reason" text NOT NULL,
	"policy" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	CONSTRAINT "deviation_scope" UNIQUE("org_id","owner_user_id","deviation_id"),
	CONSTRAINT "deviation_interval" CHECK (("deviations_v2"."end_at" IS NULL OR "deviations_v2"."end_at">"deviations_v2"."start_at") AND ("deviations_v2"."ended_at" IS NULL OR "deviations_v2"."ended_at">="deviations_v2"."start_at")),
	CONSTRAINT "deviation_scope_kind" CHECK ("deviations_v2"."scope" IN ('all','selected')),
	CONSTRAINT "deviation_type" CHECK ("deviations_v2"."type" IN ('stitch','substitute_target'))
);
--> statement-breakpoint
CREATE TABLE "dimension_definitions" (
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"measurement_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "dimension_definitions_policy_version_id_measurement_id_pk" PRIMARY KEY("policy_version_id","measurement_id"),
	CONSTRAINT "dimension_object" CHECK (jsonb_typeof("dimension_definitions"."definition")='object'),
	CONSTRAINT "dimension_identity" CHECK ((jsonb_typeof("dimension_definitions"."definition"->'measurementId') = 'string' AND "dimension_definitions"."definition"->>'measurementId' = "dimension_definitions"."measurement_id") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"deactivated_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	CONSTRAINT "domains_scope" UNIQUE("org_id","owner_user_id","domain_id"),
	CONSTRAINT "domains_slug" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "evaluation_results" (
	"result_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"day_start_hour" integer NOT NULL,
	"calculated_at" timestamp with time zone NOT NULL,
	"calculation_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"eligible_days" numeric NOT NULL,
	"result" jsonb NOT NULL,
	"components" jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"budget_snapshot" jsonb,
	"budget_enabled_snapshot" boolean DEFAULT false NOT NULL,
	CONSTRAINT "evaluation_window" UNIQUE("org_id","domain_id","window_start","window_end","policy_version_id","calculation_version"),
	CONSTRAINT "evaluation_order" CHECK ("evaluation_results"."window_end">"evaluation_results"."window_start"),
	CONSTRAINT "evaluation_day_boundary" CHECK ("evaluation_results"."day_start_hour" BETWEEN 0 AND 23),
	CONSTRAINT "evaluation_eligible" CHECK ("evaluation_results"."eligible_days">=0 AND "evaluation_results"."eligible_days"::text NOT IN ('NaN','Infinity','-Infinity')),
	CONSTRAINT "evaluation_budget" CHECK ("evaluation_results"."budget_enabled_snapshot" OR "evaluation_results"."budget_snapshot" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"observation_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"policy_version_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"observation" jsonb NOT NULL,
	"is_anomaly" boolean DEFAULT false NOT NULL,
	"anomaly_note" text,
	"deleted_at" timestamp with time zone,
	"legacy_source_type" text,
	"legacy_source_id" text,
	CONSTRAINT "observation_idempotency" UNIQUE("idempotency_key"),
	CONSTRAINT "observation_legacy_source" UNIQUE("org_id","owner_user_id","domain_id","legacy_source_type","legacy_source_id"),
	CONSTRAINT "observation_legacy_pair" CHECK (("observations"."legacy_source_type" IS NULL)=("observations"."legacy_source_id" IS NULL)),
	CONSTRAINT "observation_object" CHECK (jsonb_typeof("observations"."observation")='object'),
	CONSTRAINT "observation_identity" CHECK ((jsonb_typeof("observations"."observation"->'organizationId') = 'string' AND "observations"."observation"->>'organizationId' = "observations"."org_id") IS TRUE AND (jsonb_typeof("observations"."observation"->'ownerUserId') = 'string' AND "observations"."observation"->>'ownerUserId' = "observations"."owner_user_id") IS TRUE AND (jsonb_typeof("observations"."observation"->'domainId') = 'string' AND "observations"."observation"->>'domainId' = "observations"."domain_id") IS TRUE AND (jsonb_typeof("observations"."observation"->'policyVersionId') = 'string' AND "observations"."observation"->>'policyVersionId' = "observations"."policy_version_id") IS TRUE AND (jsonb_typeof("observations"."observation"->'observationId') = 'string' AND "observations"."observation"->>'observationId' = "observations"."observation_id") IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "members_role" CHECK ("organization_members"."role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"org_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"rollout_mode" text DEFAULT 'legacy' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_rollout" CHECK ("organizations"."rollout_mode" IN ('legacy','shadow','v2'))
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"policy_version_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"revision" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"previous_version_id" text,
	"configuration" jsonb NOT NULL,
	"evaluation_policy" jsonb,
	CONSTRAINT "policy_scope" UNIQUE("org_id","owner_user_id","domain_id","policy_version_id"),
	CONSTRAINT "policy_revision" UNIQUE("org_id","domain_id","revision"),
	CONSTRAINT "policy_revision_positive" CHECK ("policy_versions"."revision">0),
	CONSTRAINT "policy_predecessor_rule" CHECK (("policy_versions"."revision"=1)=("policy_versions"."previous_version_id" IS NULL) AND ("policy_versions"."previous_version_id" IS NULL OR "policy_versions"."previous_version_id"<>"policy_versions"."policy_version_id")),
	CONSTRAINT "policy_configuration_object" CHECK (jsonb_typeof("policy_versions"."configuration")='object'),
	CONSTRAINT "policy_configuration_identity" CHECK ((jsonb_typeof("policy_versions"."configuration"->'organizationId') = 'string' AND "policy_versions"."configuration"->>'organizationId' = "policy_versions"."org_id") IS TRUE AND (jsonb_typeof("policy_versions"."configuration"->'ownerUserId') = 'string' AND "policy_versions"."configuration"->>'ownerUserId' = "policy_versions"."owner_user_id") IS TRUE AND (jsonb_typeof("policy_versions"."configuration"->'domainId') = 'string' AND "policy_versions"."configuration"->>'domainId' = "policy_versions"."domain_id") IS TRUE AND (jsonb_typeof("policy_versions"."configuration"->'policyVersionId') = 'string' AND "policy_versions"."configuration"->>'policyVersionId' = "policy_versions"."policy_version_id") IS TRUE),
	CONSTRAINT "policy_configuration_revision" CHECK ((jsonb_typeof("policy_versions"."configuration"->'revision')='number' AND "policy_versions"."configuration"->'revision'=to_jsonb("policy_versions"."revision")) IS TRUE),
	CONSTRAINT "policy_configuration_predecessor" CHECK ((CASE WHEN "policy_versions"."previous_version_id" IS NULL THEN NOT ("policy_versions"."configuration" ? 'previousVersionId') ELSE (jsonb_typeof("policy_versions"."configuration"->'previousVersionId') = 'string' AND "policy_versions"."configuration"->>'previousVersionId' = "policy_versions"."previous_version_id") IS TRUE END) IS TRUE)
);
--> statement-breakpoint
CREATE TABLE "source_bindings" (
	"binding_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"domain_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "binding_external" UNIQUE("org_id","source_kind","external_id")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_actor" FOREIGN KEY ("org_id","actor_user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_domains" ADD CONSTRAINT "deviation_domains_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_domains" ADD CONSTRAINT "deviation_domain_deviation" FOREIGN KEY ("org_id","owner_user_id","deviation_id") REFERENCES "public"."deviations_v2"("org_id","owner_user_id","deviation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviation_domains" ADD CONSTRAINT "deviation_domain_domain" FOREIGN KEY ("org_id","owner_user_id","domain_id") REFERENCES "public"."domains"("org_id","owner_user_id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations_v2" ADD CONSTRAINT "deviations_v2_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deviations_v2" ADD CONSTRAINT "deviation_member" FOREIGN KEY ("org_id","owner_user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_definitions" ADD CONSTRAINT "dimension_definitions_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_definitions" ADD CONSTRAINT "dimension_policy" FOREIGN KEY ("org_id","owner_user_id","domain_id","policy_version_id") REFERENCES "public"."policy_versions"("org_id","owner_user_id","domain_id","policy_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_member" FOREIGN KEY ("org_id","owner_user_id") REFERENCES "public"."organization_members"("org_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_policy" FOREIGN KEY ("org_id","owner_user_id","domain_id","policy_version_id") REFERENCES "public"."policy_versions"("org_id","owner_user_id","domain_id","policy_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observation_policy" FOREIGN KEY ("org_id","owner_user_id","domain_id","policy_version_id") REFERENCES "public"."policy_versions"("org_id","owner_user_id","domain_id","policy_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_domain" FOREIGN KEY ("org_id","owner_user_id","domain_id") REFERENCES "public"."domains"("org_id","owner_user_id","domain_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_predecessor" FOREIGN KEY ("org_id","owner_user_id","domain_id","previous_version_id") REFERENCES "public"."policy_versions"("org_id","owner_user_id","domain_id","policy_version_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "source_bindings_org_id_organizations_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("org_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_bindings" ADD CONSTRAINT "binding_domain" FOREIGN KEY ("org_id","owner_user_id","domain_id") REFERENCES "public"."domains"("org_id","owner_user_id","domain_id") ON DELETE no action ON UPDATE no action;