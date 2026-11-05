/** API'nin panele döndürdüğü tipler. Secret alanları (token, secret_blob) BURADA YOKTUR. */
import type { AccountMode, Platform } from './platforms';
import type { PostStatus, ErrorClass } from './stateMachine';
import type { ValidationResult } from './validation';

export interface BrandDTO {
  id: string;
  name: string;
  slug: string;
  avatar_url: string | null;
  color: string;
  timezone: string;
  paused: boolean;
  autofill_enabled: boolean;
  autofill_days: number;
  caption_signature: string;
  queue_count: number;
  queue_days_left: number | null;
  platforms: Platform[];
  created_at: string;
}

export interface AccountDTO {
  id: string;
  brand_id: string;
  platform: Platform;
  mode: AccountMode;
  external_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string[];
  status: 'active' | 'reconnect' | 'disabled';
  last_refreshed_at: string | null;
  last_error: string | null;
  allowed: boolean;
  created_at: string;
}

export type VideoStatus = 'uploading' | 'ready' | 'invalid' | 'assigned' | 'published' | 'archived';

export interface VideoDTO {
  id: string;
  brand_id: string;
  original_name: string;
  mime: string;
  size_bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate_kbps: number | null;
  moov_at_start: boolean | null;
  title: string;
  description: string;
  hashtags: string[];
  caption_overrides: Partial<Record<Platform, string>>;
  ai_generated: boolean;
  made_for_kids: boolean;
  content_hash: string | null;
  queue_position: number;
  status: VideoStatus;
  validation: ValidationResult | null;
  thumbnail_url: string | null;
  duplicate_warning: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostDTO {
  id: string;
  trace_id: string;
  video_id: string;
  account_id: string;
  brand_id: string;
  platform: Platform;
  slot_id: string | null;
  scheduled_at: string;
  status: PostStatus;
  step: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  external_id: string | null;
  external_url: string | null;
  visibility: string | null;
  error_class: ErrorClass | null;
  last_error_code: string | null;
  last_error_message: string | null;
  caption_snapshot: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  video_title: string | null;
  thumbnail_url: string | null;
}

export interface PostEventDTO {
  id: string;
  at: string;
  from_status: PostStatus | null;
  to_status: PostStatus | null;
  step: string | null;
  detail: Record<string, unknown> | null;
}

export interface SlotDTO {
  id: string;
  brand_id: string;
  weekday: number;
  time_local: string;
  platforms: Platform[];
  active: boolean;
}

export interface SettingsDTO {
  kill_switch: boolean;
  youtube_audited: boolean;
  missed_slot_grace_min: number;
  retention_days: number;
  notify: { slack: boolean; telegram: boolean };
  notify_available: { slack: boolean; telegram: boolean };
  autofill_default_days: number;
  weekly_report: boolean;
  dry_run: boolean;
  allowed_account_ids: string[];
}

export interface MetricPoint {
  post_id: string;
  platform: Platform;
  brand_id: string;
  published_at: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

export interface HeatCell {
  weekday: number; // 1-7
  hour: number; // 0-23
  posts: number;
  median_rate: number | null;
}

export interface AnalyticsDTO {
  totals: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    posts: number;
  };
  daily: { day: string; views: number; engagement: number }[];
  heatmap: HeatCell[];
  best_hours: { weekday: number; hour: number; median_rate: number }[];
  top_posts: (MetricPoint & { title: string | null; url: string | null })[];
  min_posts_per_bucket: number;
}

export interface QuotaDTO {
  youtube: {
    day: string;
    uploads_used: number;
    uploads_limit: number;
    units_used: number;
    units_limit: number;
  };
  instagram: Record<
    string,
    { quota_usage: number | null; quota_total: number | null; fetched_at: string | null }
  >;
}

export interface AuditDTO {
  id: string;
  at: string;
  actor_email: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface MeDTO {
  email: string;
  dev_bypass: boolean;
}

export interface TemplateDTO {
  id: string;
  brand_id: string;
  kind: 'caption' | 'hashtags';
  name: string;
  platform: Platform | null;
  body: string;
  updated_at: string;
}

export interface WeeklyReportDTO {
  brand_id: string;
  brand_name: string;
  period: { from: string; to: string };
  posts: number;
  views: number;
  engagement: number;
  views_change: number | null;
  engagement_change: number | null;
  top: { title: string | null; platform: Platform; views: number; url: string | null }[];
  next_week: { scheduled: number; slots: number; fill_rate: number | null };
  queue: { count: number; days_left: number | null };
  needs_action: number;
  failed: number;
  text: string;
}

export type HealthLevel = 'ok' | 'warn' | 'error';

export interface HealthCheck {
  key: string;
  label: string;
  level: HealthLevel;
  detail: string;
}

export interface HealthDTO {
  level: HealthLevel;
  now: string;
  checks: HealthCheck[];
  counts: {
    processing: number;
    retrying: number;
    overdue: number;
    needs_action: number;
    failed_24h: number;
    dlq_24h: number;
    inbox_waiting: number;
  };
  last_cron_at: string | null;
  last_daily_at: string | null;
  tokens: {
    account_id: string;
    platform: Platform;
    username: string | null;
    status: string;
    token_expires_at: string | null;
  }[];
}
