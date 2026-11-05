/** Satır → DTO. Alanlar AÇIKÇA seçilir: secret_blob / token alanları asla kopyalanmaz. */
import type {
  AccountDTO,
  BrandDTO,
  PostDTO,
  SlotDTO,
  ValidationResult,
  VideoDTO,
} from '@socialplan/shared';
import { isAccountAllowed, type Env } from '../env';
import { bool, parseJson } from './db';
import type { AccountRow, BrandRow, PostRow, SlotRow, VideoRow } from './rows';

export function toBrandDTO(
  r: BrandRow,
  extra: Pick<BrandDTO, 'queue_count' | 'queue_days_left' | 'platforms'>,
): BrandDTO {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    avatar_url: r.avatar_key
      ? `/api/media/avatar/${r.id}?v=${encodeURIComponent(r.updated_at)}`
      : null,
    color: r.color,
    timezone: r.timezone,
    paused: bool(r.paused),
    autofill_enabled: bool(r.autofill_enabled),
    autofill_days: r.autofill_days,
    caption_signature: r.caption_signature ?? '',
    created_at: r.created_at,
    ...extra,
  };
}

export function toAccountDTO(env: Env, r: AccountRow): AccountDTO {
  return {
    id: r.id,
    brand_id: r.brand_id,
    platform: r.platform,
    mode: r.mode,
    external_id: r.external_id,
    username: r.username,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    token_expires_at: r.token_expires_at,
    refresh_expires_at: r.refresh_expires_at,
    scopes: r.scopes ? r.scopes.split(/[ ,]+/).filter(Boolean) : [],
    status: r.status,
    last_refreshed_at: r.last_refreshed_at,
    last_error: r.last_error,
    allowed: isAccountAllowed(env, r),
    created_at: r.created_at,
  };
}

export function toVideoDTO(r: VideoRow, duplicateWarning: string | null = null): VideoDTO {
  return {
    id: r.id,
    brand_id: r.brand_id,
    original_name: r.original_name,
    mime: r.mime,
    size_bytes: r.size_bytes,
    duration_ms: r.duration_ms,
    width: r.width,
    height: r.height,
    fps: r.fps,
    video_codec: r.video_codec,
    audio_codec: r.audio_codec,
    bitrate_kbps: r.bitrate_kbps,
    moov_at_start: r.moov_at_start === null ? null : bool(r.moov_at_start),
    title: r.title,
    description: r.description,
    hashtags: parseJson<string[]>(r.hashtags, []),
    caption_overrides: parseJson(r.caption_overrides, {}),
    ai_generated: bool(r.ai_generated),
    made_for_kids: bool(r.made_for_kids),
    content_hash: r.content_hash,
    queue_position: r.queue_position,
    status: r.status,
    validation: parseJson<ValidationResult | null>(r.validation, null),
    thumbnail_url: r.thumbnail_key
      ? `/api/media/thumb/${r.id}?v=${encodeURIComponent(r.updated_at)}`
      : null,
    duplicate_warning: duplicateWarning,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function toSlotDTO(r: SlotRow): SlotDTO {
  return {
    id: r.id,
    brand_id: r.brand_id,
    weekday: r.weekday,
    time_local: r.time_local,
    platforms: parseJson(r.platforms, []),
    active: bool(r.active),
  };
}

export function toPostDTO(
  r: PostRow & {
    video_title?: string | null;
    thumbnail_key?: string | null;
    video_updated_at?: string | null;
  },
): PostDTO {
  return {
    id: r.id,
    trace_id: r.trace_id,
    video_id: r.video_id,
    account_id: r.account_id,
    brand_id: r.brand_id,
    platform: r.platform,
    slot_id: r.slot_id,
    scheduled_at: r.scheduled_at,
    status: r.status,
    step: r.step,
    attempt_count: r.attempt_count,
    next_attempt_at: r.next_attempt_at,
    external_id: r.external_id,
    external_url: r.external_url,
    visibility: r.visibility,
    error_class: r.error_class,
    last_error_code: r.last_error_code,
    last_error_message: r.last_error_message,
    caption_snapshot: r.caption_snapshot,
    published_at: r.published_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    video_title: r.video_title ?? null,
    thumbnail_url: r.thumbnail_key
      ? `/api/media/thumb/${r.video_id}?v=${encodeURIComponent(r.video_updated_at ?? '')}`
      : null,
  };
}
