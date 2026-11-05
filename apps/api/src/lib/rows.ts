/** D1 satır tipleri (ham). */
import type {
  AccountMode,
  Platform,
  PostStatus,
  ErrorClass,
  VideoStatus,
} from '@socialplan/shared';

export interface BrandRow {
  id: string;
  name: string;
  slug: string;
  avatar_key: string | null;
  color: string;
  timezone: string;
  paused: number;
  autofill_enabled: number;
  autofill_days: number;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  id: string;
  brand_id: string;
  platform: Platform;
  mode: AccountMode;
  external_id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  secret_blob: string | null;
  secret_key_version: number;
  token_expires_at: string | null;
  refresh_expires_at: string | null;
  scopes: string;
  status: 'active' | 'reconnect' | 'disabled';
  last_refreshed_at: string | null;
  last_error: string | null;
  meta: string;
  created_at: string;
  updated_at: string;
}

export interface VideoRow {
  id: string;
  brand_id: string;
  r2_key: string;
  thumbnail_key: string | null;
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
  moov_at_start: number | null;
  title: string;
  description: string;
  hashtags: string;
  caption_overrides: string;
  ai_generated: number | null;
  made_for_kids: number;
  content_hash: string | null;
  queue_position: number;
  status: VideoStatus;
  validation: string | null;
  multipart_upload_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SlotRow {
  id: string;
  brand_id: string;
  weekday: number;
  time_local: string;
  platforms: string;
  active: number;
}

export interface PostRow {
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
  platform_state: string;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  commit_started_at: string | null;
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
}
