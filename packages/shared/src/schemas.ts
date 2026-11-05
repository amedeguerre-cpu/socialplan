import { z } from 'zod';
import { PLATFORMS } from './platforms';
import { POST_STATUSES } from './stateMachine';

export const platformSchema = z.enum(PLATFORMS);
export const postStatusSchema = z.enum(POST_STATUSES);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM bekleniyor');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD bekleniyor');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** Kabul edilen video türleri (izin listesi; panel kökeninden sunulduğu için serbest metin değil). */
export const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;
export const videoMimeSchema = z.enum(VIDEO_MIMES, {
  error: 'Desteklenmeyen dosya türü (MP4, MOV, WebM)',
});

export const brandCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, 'küçük harf, rakam, tire')
    .optional(),
  color: color.optional(),
  timezone: z.string().min(1).max(64).optional(),
});
export const brandUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: color.optional(),
  timezone: z.string().min(1).max(64).optional(),
  paused: z.boolean().optional(),
  autofill_enabled: z.boolean().optional(),
  autofill_days: z.number().int().min(1).max(60).optional(),
  avatar_key: z.string().max(300).nullable().optional(),
  caption_signature: z.string().max(300).optional(),
});

export const captionOverridesSchema = z
  .object({
    instagram: z.string().max(2200).optional(),
    youtube: z.string().max(5000).optional(),
    tiktok: z.string().max(2200).optional(),
  })
  .strict();

export const videoMetaSchema = z.object({
  mime: videoMimeSchema,
  originalName: z.string().max(300),
  sizeBytes: z.number().int().positive(),
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fps: z.number().positive().nullable(),
  videoCodec: z.string().max(60).nullable(),
  audioCodec: z.string().max(60).nullable(),
  audioSampleRate: z.number().int().positive().nullable().optional(),
  bitrateKbps: z.number().nonnegative().nullable(),
  moovAtStart: z.boolean().nullable(),
});

export const uploadInitSchema = z.object({
  brand_id: z.string().min(1),
  original_name: z.string().min(1).max(300),
  mime: videoMimeSchema,
  size_bytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024),
  content_hash: z
    .string()
    .regex(/^[0-9a-f]{16,128}$/)
    .optional(),
});

export const uploadCompleteSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10000), etag: z.string().min(1) }))
    .min(1),
  meta: videoMetaSchema,
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  ai_generated: z.boolean({ error: 'Yapay zekâ ile üretildi mi? seçimi zorunlu' }),
  made_for_kids: z.boolean().optional(),
  thumbnail: z.boolean().optional(),
});

export const videoUpdateSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  hashtags: z
    .array(z.string().regex(/^#?[\p{L}\p{N}_]{1,100}$/u))
    .max(30)
    .optional(),
  caption_overrides: captionOverridesSchema.optional(),
  ai_generated: z.boolean().optional(),
  made_for_kids: z.boolean().optional(),
  status: z.enum(['ready', 'archived']).optional(),
});

export const reorderSchema = z.object({
  /** Taşınan videonun yeni komşuları (null = başa/sona). */
  before_id: z.string().nullable(),
  after_id: z.string().nullable(),
});

export const slotUpsertSchema = z.object({
  brand_id: z.string().min(1),
  weekday: z.number().int().min(1).max(7),
  time_local: hm,
  platforms: z.array(platformSchema).min(1),
  active: z.boolean().optional(),
});

export const slotUpdateSchema = z.object({
  weekday: z.number().int().min(1).max(7).optional(),
  time_local: hm.optional(),
  platforms: z.array(platformSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export const manualScheduleSchema = z.object({
  video_id: z.string().min(1),
  platforms: z.array(platformSchema).min(1),
  /** Marka saat diliminde yerel tarih-saat. */
  date: ymd,
  time: hm,
  status: z.enum(['scheduled', 'draft']).optional(),
});

export const fillSchema = z.object({
  brand_id: z.string().min(1),
  days: z.number().int().min(1).max(60).optional(),
});

export const postUpdateSchema = z.object({
  caption_snapshot: z.string().max(5000).optional(),
  /** Yeni zaman (UTC ISO). */
  scheduled_at: z.iso.datetime().optional(),
});

export const markPublishedSchema = z.object({
  url: z.url().max(500).optional(),
});

export const bulkPostsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  action: z.enum(['cancel', 'retry']),
});

export const postListQuerySchema = z.object({
  brand_id: z.string().optional(),
  platform: platformSchema.optional(),
  status: postStatusSchema.optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).optional(),
  page_size: z.coerce.number().int().min(1).max(200).optional(),
});

export const notifyConfigSchema = z.object({
  slack: z.boolean(),
  telegram: z.boolean(),
});

export const settingsUpdateSchema = z.object({
  kill_switch: z.boolean().optional(),
  youtube_audited: z.boolean().optional(),
  missed_slot_grace_min: z.number().int().min(1).max(1440).optional(),
  retention_days: z.number().int().min(1).max(365).optional(),
  notify: notifyConfigSchema.optional(),
  autofill_default_days: z.number().int().min(1).max(60).optional(),
  weekly_report: z.boolean().optional(),
});

export const templateCreateSchema = z.object({
  brand_id: z.string().min(1),
  kind: z.enum(['caption', 'hashtags']),
  name: z.string().trim().min(1).max(60),
  platform: platformSchema.nullable().optional(),
  body: z.string().trim().min(1).max(2200),
});
export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  platform: platformSchema.nullable().optional(),
  body: z.string().trim().min(1).max(2200).optional(),
});

export type BrandCreate = z.infer<typeof brandCreateSchema>;
export type BrandUpdate = z.infer<typeof brandUpdateSchema>;
export type UploadInit = z.infer<typeof uploadInitSchema>;
export type UploadComplete = z.infer<typeof uploadCompleteSchema>;
export type VideoUpdate = z.infer<typeof videoUpdateSchema>;
export type SlotUpsert = z.infer<typeof slotUpsertSchema>;
export type ManualSchedule = z.infer<typeof manualScheduleSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type PostListQuery = z.infer<typeof postListQuerySchema>;
