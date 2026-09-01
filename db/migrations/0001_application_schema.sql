CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"paddle_subscription_id" text,
	"paddle_customer_id" text,
	"paddle_price_id" text,
	"plan_slug" text NOT NULL,
	"status" text NOT NULL,
	"billing_cycle" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_chk" CHECK ("subscriptions"."status" IN ('active','trialing','past_due','paused','canceled')),
	CONSTRAINT "subscriptions_cycle_chk" CHECK ("subscriptions"."billing_cycle" IS NULL OR "subscriptions"."billing_cycle" IN ('monthly','yearly'))
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"paddle_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"occurred_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_status_chk" CHECK ("billing_events"."status" IN ('received','processed','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "usage" (
	"user_id" text PRIMARY KEY NOT NULL,
	"storage_retained_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_pending_deletion_bytes" bigint DEFAULT 0 NOT NULL,
	"active_video_count" integer DEFAULT 0 NOT NULL,
	"reserved_video_slots" integer DEFAULT 0 NOT NULL,
	"recording_seconds" bigint DEFAULT 0 NOT NULL,
	"monthly_uploads" integer DEFAULT 0 NOT NULL,
	"monthly_period" text,
	"last_recalculated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_retained_chk" CHECK ("usage"."storage_retained_bytes" >= 0),
	CONSTRAINT "usage_reserved_chk" CHECK ("usage"."storage_reserved_bytes" >= 0),
	CONSTRAINT "usage_pending_chk" CHECK ("usage"."storage_pending_deletion_bytes" >= 0),
	CONSTRAINT "usage_video_count_chk" CHECK ("usage"."active_video_count" >= 0),
	CONSTRAINT "usage_slots_chk" CHECK ("usage"."reserved_video_slots" >= 0),
	CONSTRAINT "usage_seconds_chk" CHECK ("usage"."recording_seconds" >= 0),
	CONSTRAINT "usage_monthly_uploads_chk" CHECK ("usage"."monthly_uploads" >= 0)
);
--> statement-breakpoint
CREATE TABLE "plan_overrides" (
	"plan_slug" text PRIMARY KEY NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edit_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_sessions_status_chk" CHECK ("edit_sessions"."status" IN ('draft','rendering','applied','discarded')),
	CONSTRAINT "edit_sessions_mode_chk" CHECK ("edit_sessions"."mode" IS NULL OR "edit_sessions"."mode" IN ('overwrite','copy'))
);
--> statement-breakpoint
CREATE TABLE "edit_operations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"edit_session_id" text NOT NULL,
	"idx" integer NOT NULL,
	"op" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edit_operations_idx_chk" CHECK ("edit_operations"."idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"edit_session_id" text NOT NULL,
	"processing_job_id" text,
	"output_recording_id" text,
	"output_asset_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "render_jobs_status_chk" CHECK ("render_jobs"."status" IN ('queued','running','done','failed'))
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"max_views" integer,
	"view_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_views_chk" CHECK ("share_links"."view_count" >= 0 AND ("share_links"."max_views" IS NULL OR "share_links"."max_views" > 0))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"parent_id" text,
	"user_id" text,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"t" numeric(10, 3),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_body_chk" CHECK (length("comments"."body") BETWEEN 1 AND 2000),
	CONSTRAINT "comments_t_chk" CHECK ("comments"."t" IS NULL OR "comments"."t" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text,
	"author_name" text,
	"emoji" text NOT NULL,
	"t" numeric(10, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_emoji_chk" CHECK (length("reactions"."emoji") BETWEEN 1 AND 8),
	CONSTRAINT "reactions_t_chk" CHECK ("reactions"."t" IS NULL OR "reactions"."t" >= 0)
);
--> statement-breakpoint
CREATE TABLE "view_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"viewer_user_id" text,
	"visitor_id" text,
	"ip_hash" text,
	"viewer_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"max_progress" numeric(4, 3) DEFAULT '0' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	CONSTRAINT "view_sessions_progress_chk" CHECK ("view_sessions"."max_progress" >= 0 AND "view_sessions"."max_progress" <= 1)
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"recording_id" text,
	"user_id" text,
	"event" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"google_id" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"manual_plan" text,
	"manual_plan_expires" timestamp with time zone,
	"slack_webhook" text,
	"paddle_customer_id" text,
	"reset_token_hash" text,
	"reset_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"client" text NOT NULL,
	"user_agent" text,
	"ip" "inet",
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_client_chk" CHECK ("sessions"."client" IN ('web','extension'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_chk" CHECK ("workspace_members"."role" IN ('owner','admin','member','viewer'))
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"recording_id" text,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"enqueued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processing_jobs_queue_chk" CHECK ("processing_jobs"."queue" IN ('probe','transcode','thumbnail','hls','audio_extract','captions','transcribe','translate','ai_title','ai_summary','ai_chapters','render','cleanup','usage_sync','subscription_sync','upload_expiry','email')),
	CONSTRAINT "processing_jobs_status_chk" CHECK ("processing_jobs"."status" IN ('queued','active','completed','failed','cancelled')),
	CONSTRAINT "processing_jobs_attempts_chk" CHECK ("processing_jobs"."attempts" >= 0 AND "processing_jobs"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"title" text DEFAULT 'Untitled Recording' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"failure_code" text,
	"duration" numeric(10, 3),
	"client_duration_hint" numeric(10, 3),
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"source_kind" text NOT NULL,
	"privacy" text DEFAULT 'unlisted' NOT NULL,
	"password_hash" text,
	"folder_id" text,
	"trim_start" numeric(10, 3),
	"trim_end" numeric(10, 3),
	"segments" jsonb,
	"chapters" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cta" jsonb,
	"recommended_speed" numeric(3, 2),
	"animated_thumbnail" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"remove_branding" boolean DEFAULT false NOT NULL,
	"ai_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "recordings_status_chk" CHECK ("recordings"."status" IN ('recording','uploading','uploaded','processing','ready','failed','rejected_limit')),
	CONSTRAINT "recordings_privacy_chk" CHECK ("recordings"."privacy" IN ('public','unlisted','workspace','login','password')),
	CONSTRAINT "recordings_source_kind_chk" CHECK ("recordings"."source_kind" IN ('extension','web_upload','render','duplicate')),
	CONSTRAINT "recordings_ai_status_chk" CHECK ("recordings"."ai_status" IN ('none','queued','running','done','failed')),
	CONSTRAINT "recordings_duration_chk" CHECK ("recordings"."duration" IS NULL OR "recordings"."duration" >= 0),
	CONSTRAINT "recordings_size_chk" CHECK ("recordings"."size_bytes" IS NULL OR "recordings"."size_bytes" >= 0),
	CONSTRAINT "recordings_speed_chk" CHECK ("recordings"."recommended_speed" IS NULL OR ("recordings"."recommended_speed" >= 0.25 AND "recordings"."recommended_speed" <= 4)),
	CONSTRAINT "recordings_password_chk" CHECK ("recordings"."privacy" <> 'password' OR "recordings"."password_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "video_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"size_bytes" bigint,
	"width" integer,
	"height" integer,
	"duration" numeric(10, 3),
	"codec_video" text,
	"codec_audio" text,
	"container" text,
	"checksum" text,
	"variant" text,
	"immutable" boolean DEFAULT false NOT NULL,
	"counts_toward_quota" boolean DEFAULT false NOT NULL,
	"created_by_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "video_assets_kind_chk" CHECK ("video_assets"."kind" IN ('source','mp4','hls','poster','thumbnail','preview_gif','audio','captions_vtt','render_output')),
	CONSTRAINT "video_assets_status_chk" CHECK ("video_assets"."status" IN ('pending','ready','failed')),
	CONSTRAINT "video_assets_size_chk" CHECK ("video_assets"."size_bytes" IS NULL OR "video_assets"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"user_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"storage_upload_id" text,
	"mode" text DEFAULT 'multipart' NOT NULL,
	"part_size" integer NOT NULL,
	"byte_ceiling" bigint NOT NULL,
	"client_mime" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_mode_chk" CHECK ("upload_sessions"."mode" IN ('multipart','single')),
	CONSTRAINT "upload_sessions_status_chk" CHECK ("upload_sessions"."status" IN ('pending','active','completed','aborted','expired')),
	CONSTRAINT "upload_sessions_part_size_chk" CHECK ("upload_sessions"."part_size" > 0),
	CONSTRAINT "upload_sessions_ceiling_chk" CHECK ("upload_sessions"."byte_ceiling" > 0)
);
--> statement-breakpoint
CREATE TABLE "upload_parts" (
	"upload_session_id" text NOT NULL,
	"part_number" integer NOT NULL,
	"size" bigint NOT NULL,
	"etag" text,
	"crc32c" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_parts_pk" PRIMARY KEY("upload_session_id","part_number"),
	CONSTRAINT "upload_parts_number_chk" CHECK ("upload_parts"."part_number" >= 1 AND "upload_parts"."part_number" <= 10000),
	CONSTRAINT "upload_parts_size_chk" CHECK ("upload_parts"."size" >= 0),
	CONSTRAINT "upload_parts_status_chk" CHECK ("upload_parts"."status" IN ('pending','uploaded'))
);
--> statement-breakpoint
CREATE TABLE "storage_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"upload_session_id" text,
	"render_job_id" text,
	"reserved_bytes" bigint NOT NULL,
	"reserved_slots" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"reconciled_bytes" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_reservations_status_chk" CHECK ("storage_reservations"."status" IN ('held','reconciled','released','expired')),
	CONSTRAINT "storage_reservations_bytes_chk" CHECK ("storage_reservations"."reserved_bytes" >= 0 AND ("storage_reservations"."reconciled_bytes" IS NULL OR "storage_reservations"."reconciled_bytes" >= 0)),
	CONSTRAINT "storage_reservations_slots_chk" CHECK ("storage_reservations"."reserved_slots" >= 0),
	CONSTRAINT "storage_reservations_owner_chk" CHECK (("storage_reservations"."upload_session_id" IS NOT NULL AND "storage_reservations"."render_job_id" IS NULL) OR ("storage_reservations"."upload_session_id" IS NULL AND "storage_reservations"."render_job_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"language" text,
	"text" text,
	"source" text,
	"spoken_lang_override" text,
	"stale" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_status_chk" CHECK ("transcripts"."status" IN ('queued','running','done','failed')),
	CONSTRAINT "transcripts_source_chk" CHECK ("transcripts"."source" IS NULL OR "transcripts"."source" IN ('groq','whisper_cpp'))
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"transcript_id" text NOT NULL,
	"idx" integer NOT NULL,
	"start_s" numeric(10, 3) NOT NULL,
	"end_s" numeric(10, 3) NOT NULL,
	"text" text NOT NULL,
	"language" text,
	CONSTRAINT "transcript_segments_range_chk" CHECK ("transcript_segments"."start_s" >= 0 AND "transcript_segments"."end_s" >= "transcript_segments"."start_s"),
	CONSTRAINT "transcript_segments_idx_chk" CHECK ("transcript_segments"."idx" >= 0)
);
--> statement-breakpoint
CREATE TABLE "transcript_translations" (
	"transcript_id" text NOT NULL,
	"lang" text NOT NULL,
	"segments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_translations_pk" PRIMARY KEY("transcript_id","lang")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text,
	"message" text NOT NULL,
	"user_id" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_status_chk" CHECK ("contacts"."status" IN ('new','read','replied','archived'))
);
--> statement-breakpoint
CREATE TABLE "notification_reads" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"detail" jsonb,
	"ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage" ADD CONSTRAINT "usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_overrides" ADD CONSTRAINT "plan_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_sessions" ADD CONSTRAINT "edit_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_sessions" ADD CONSTRAINT "edit_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_operations" ADD CONSTRAINT "edit_operations_edit_session_id_edit_sessions_id_fk" FOREIGN KEY ("edit_session_id") REFERENCES "public"."edit_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_edit_session_id_edit_sessions_id_fk" FOREIGN KEY ("edit_session_id") REFERENCES "public"."edit_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_processing_job_id_processing_jobs_id_fk" FOREIGN KEY ("processing_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_output_recording_id_recordings_id_fk" FOREIGN KEY ("output_recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_output_asset_id_video_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."video_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_sessions" ADD CONSTRAINT "view_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "view_sessions" ADD CONSTRAINT "view_sessions_viewer_user_id_users_id_fk" FOREIGN KEY ("viewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_created_by_job_id_processing_jobs_id_fk" FOREIGN KEY ("created_by_job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_parts" ADD CONSTRAINT "upload_parts_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_upload_session_id_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_reservations" ADD CONSTRAINT "storage_reservations_render_job_id_render_jobs_id_fk" FOREIGN KEY ("render_job_id") REFERENCES "public"."render_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_translations" ADD CONSTRAINT "transcript_translations_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_uniq" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_paddle_sub_uniq" ON "subscriptions" USING btree ("paddle_subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_paddle_event_uniq" ON "billing_events" USING btree ("paddle_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_status_idx" ON "billing_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "edit_sessions_recording_idx" ON "edit_sessions" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "edit_sessions_user_idx" ON "edit_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edit_sessions_rendering_uniq" ON "edit_sessions" USING btree ("recording_id") WHERE status = 'rendering';--> statement-breakpoint
CREATE UNIQUE INDEX "edit_operations_session_idx_uniq" ON "edit_operations" USING btree ("edit_session_id","idx");--> statement-breakpoint
CREATE INDEX "render_jobs_edit_session_idx" ON "render_jobs" USING btree ("edit_session_id");--> statement-breakpoint
CREATE INDEX "render_jobs_status_idx" ON "render_jobs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_uniq" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_recording_idx" ON "share_links" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "comments_recording_created_idx" ON "comments" USING btree ("recording_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "reactions_recording_idx" ON "reactions" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "view_sessions_recording_viewer_uniq" ON "view_sessions" USING btree ("recording_id","viewer_key");--> statement-breakpoint
CREATE INDEX "view_sessions_recording_idx" ON "view_sessions" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "view_sessions_viewer_user_idx" ON "view_sessions" USING btree ("viewer_user_id");--> statement-breakpoint
CREATE INDEX "analytics_events_event_created_idx" ON "analytics_events" USING btree ("event","created_at");--> statement-breakpoint
CREATE INDEX "analytics_events_recording_created_idx" ON "analytics_events" USING btree ("recording_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_recording_email_uniq" ON "leads" USING btree ("recording_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_live_uniq" ON "users" USING btree ("email") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_id_uniq" ON "users" USING btree ("google_id");--> statement-breakpoint
CREATE INDEX "users_paddle_customer_idx" ON "users" USING btree ("paddle_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uniq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "workspaces" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_dedupe_key_uniq" ON "processing_jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "processing_jobs_recording_idx" ON "processing_jobs" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_queue_status_idx" ON "processing_jobs" USING btree ("queue","status");--> statement-breakpoint
CREATE INDEX "processing_jobs_outbox_idx" ON "processing_jobs" USING btree ("created_at") WHERE enqueued_at IS NULL AND status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "folders_user_name_uniq" ON "folders" USING btree ("user_id",lower("name"));--> statement-breakpoint
CREATE INDEX "recordings_user_created_idx" ON "recordings" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "recordings_user_folder_idx" ON "recordings" USING btree ("user_id","folder_id");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "recordings_workspace_idx" ON "recordings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "recordings_tags_gin_idx" ON "recordings" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "video_assets_storage_key_uniq" ON "video_assets" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "video_assets_recording_kind_idx" ON "video_assets" USING btree ("recording_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "video_assets_ready_variant_uniq" ON "video_assets" USING btree ("recording_id","kind",coalesce("variant", '')) WHERE status = 'ready';--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_user_idempotency_uniq" ON "upload_sessions" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_sessions_recording_active_uniq" ON "upload_sessions" USING btree ("recording_id") WHERE status IN ('pending','active');--> statement-breakpoint
CREATE INDEX "upload_sessions_status_expires_idx" ON "upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "upload_sessions_user_idx" ON "upload_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_reservations_upload_session_uniq" ON "storage_reservations" USING btree ("upload_session_id");--> statement-breakpoint
CREATE INDEX "storage_reservations_status_expires_idx" ON "storage_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "storage_reservations_user_idx" ON "storage_reservations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_recording_uniq" ON "transcripts" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_transcript_idx_uniq" ON "transcript_segments" USING btree ("transcript_id","idx");--> statement-breakpoint
CREATE INDEX "transcript_segments_transcript_idx" ON "transcript_segments" USING btree ("transcript_id");--> statement-breakpoint
CREATE INDEX "contacts_status_created_idx" ON "contacts" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_created_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");

--> statement-breakpoint
-- ── updated_at triggers ───────────────────────────────────────────────────
-- Uses set_updated_at(), created by migration 0000. Applied to every table
-- carrying an updated_at column (docs/07 §1 convention), so application code
-- can never forget to bump it.
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "subscriptions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "usage" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "plan_overrides" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "edit_sessions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "render_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "share_links" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "comments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "workspaces" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "processing_jobs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "folders" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "recordings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "video_assets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "upload_sessions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "upload_parts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "storage_reservations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "transcripts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "contacts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "notification_reads" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
