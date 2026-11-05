/**
 * YouTube Shorts — Data API v3, resumable upload.
 * Akış: kota defteri + audit denetimi → oturum (Location) → 8 MiB parçalar (308 + Range) → son parça (commit) → video.
 * Audit'siz projeden yüklenen video kalıcı private kilitlenir: youtube_audited=false iken privacyStatus=private ve
 * yalnız ALLOWED_ACCOUNT_IDS'teki test kanalına izin verilir. Shorts için API bayrağı yok (dikey/kare, ≤ 3 dk).
 * Kaynak (arama özetleriyle 31.10–05.11.2026):
 *  https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *  https://developers.google.com/youtube/v3/docs/videos/insert
 */
import { addDaysYmd, pacificDay, QUOTAS, youtubeTitle, zonedToUtc } from '@socialplan/shared';
import { allowedAccountIds, isAccountAllowed } from '../env';
import { parseJson } from '../lib/db';
import type { VideoRow } from '../lib/rows';
import type { AccountTokens } from '../lib/tokens';
import { b64urlEncode } from '../lib/crypto';
import { expiresAt, OAuthError, type OAuthAdapter } from '../oauth/types';
import { classifyGeneric, classifyStatus, PlatformHttpError, type ClassifiedError } from './errors';
import { readJson, retryAfterSeconds, type HttpClient } from './http';
import {
  AUTH_EXPIRED,
  type BaseState,
  type PublishContext,
  type Publisher,
  type StepResult,
} from './types';

const YT_API = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];
/** 256 KiB katı olmalı; 8 MiB kullanılır. */
export const YT_CHUNK = 8 * 1024 * 1024;
const CHUNKS_PER_STEP = 4;
const MAX_SESSIONS = 3;

export interface YtState extends BaseState {
  step: 'quota' | 'session' | 'upload';
  quotaDay?: string;
  privacy?: 'private' | 'public';
  sessionUri?: string;
  sessionAt?: string;
  offset?: number;
  size?: number;
  verify?: boolean;
  sessions?: number;
  title?: string;
}

interface GoogleError {
  error?:
    | {
        code?: number;
        message?: string;
        errors?: { reason?: string; message?: string }[];
        status?: string;
      }
    | string;
  error_description?: string;
}

/** Sonraki Pasifik gece yarısına kalan saniye (kota sıfırlanması). */
export function secondsUntilPacificMidnight(now: Date): number {
  const next = zonedToUtc(addDaysYmd(pacificDay(now), 1), '00:00', QUOTAS.youtube.resetTimeZone);
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000) + 60);
}

export function classifyYt(
  res: Response,
  body: GoogleError | null,
  now = new Date(),
): ClassifiedError {
  const e = typeof body?.error === 'object' ? body.error : undefined;
  const reason =
    e?.errors?.[0]?.reason ?? (typeof body?.error === 'string' ? body.error : undefined);
  const msg = `YouTube: ${e?.message ?? body?.error_description ?? reason ?? `HTTP ${res.status}`}`;
  if (res.status === 401 || reason === 'authError' || reason === 'invalid_token')
    return { class: 'transient', code: AUTH_EXPIRED, message: msg };
  if (
    reason === 'quotaExceeded' ||
    reason === 'uploadLimitExceeded' ||
    reason === 'dailyLimitExceeded'
  ) {
    return {
      class: 'transient',
      code: 'yt_quota',
      message: msg,
      retryAfterSec: secondsUntilPacificMidnight(now),
    };
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || res.status === 429) {
    return {
      class: 'transient',
      code: 'rate_limited',
      message: msg,
      retryAfterSec: retryAfterSeconds(res) ?? 60,
    };
  }
  if (reason === 'youtubeSignupRequired')
    return {
      class: 'action',
      code: 'yt_no_channel',
      message: `${msg} (hesapta YouTube kanalı yok)`,
    };
  if (reason === 'forbidden' || reason === 'insufficientPermissions')
    return { class: 'action', code: 'yt_forbidden', message: msg };
  if (
    reason === 'invalidTitle' ||
    reason === 'invalidDescription' ||
    reason === 'invalidTags' ||
    reason === 'mediaBodyRequired'
  ) {
    return { class: 'permanent', code: `yt_${reason}`, message: msg };
  }
  if (reason === 'backendError' || res.status >= 500)
    return { class: 'transient', code: `yt_${reason ?? res.status}`, message: msg };
  return classifyStatus(res, msg, reason ? `yt_${reason}` : undefined);
}

async function ytJson<T>(
  http: HttpClient,
  token: string,
  method: string,
  url: string,
  body: unknown,
  purpose: string,
  now: Date,
): Promise<T> {
  const res = await http.fetch(
    url,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    { purpose, platform: 'youtube' },
  );
  const j = await readJson<T & GoogleError>(res);
  if (!res.ok) throw new PlatformHttpError(res.status, classifyYt(res, j, now));
  return j as T;
}

function parseYoutubeTitle(v: VideoRow): string {
  return youtubeTitle({
    title: v.title,
    description: v.description,
    hashtags: parseJson(v.hashtags, []),
    caption_overrides: parseJson(v.caption_overrides, {}),
  });
}

const tok = async (ctx: PublishContext): Promise<string> => (await ctx.tokens()).access_token;

function snippet(ctx: PublishContext, title: string) {
  const tags = parseJson<string[]>(ctx.video.hashtags, [])
    .map((t) => t.replace(/^#/, ''))
    .slice(0, 15);
  return { title, description: ctx.caption.slice(0, 5000), tags, categoryId: '22' };
}

async function quota(ctx: PublishContext, s: YtState): Promise<StepResult<YtState>> {
  const audited = ctx.settings.youtube_audited;
  if (!audited) {
    // Audit yokken yalnız beyaz listedeki test kanalı; liste boşsa hiçbir kanal.
    const list = allowedAccountIds(ctx.env);
    if (!list.length || !isAccountAllowed(ctx.env, ctx.account)) {
      return {
        kind: 'error',
        class: 'action',
        code: 'youtube_not_audited',
        message:
          'YouTube audit onayı yok: yükleme yalnız ALLOWED_ACCOUNT_IDS içindeki test kanalına (private) yapılabilir',
      };
    }
  }
  const day = pacificDay(ctx.now);
  if (s.quotaDay !== day) {
    const ok = await ctx.quota.use(
      'youtube',
      'project',
      day,
      'uploads',
      1,
      QUOTAS.youtube.uploadsPerDay.value,
    );
    if (!ok) {
      ctx.log.warn('youtube.quota_full', { day });
      return {
        kind: 'continue',
        state: { ...s, step: 'quota' },
        waitSeconds: Math.min(secondsUntilPacificMidnight(ctx.now), 12 * 3600),
      };
    }
  }
  return {
    kind: 'continue',
    state: { ...s, step: 'session', quotaDay: day, privacy: audited ? 'public' : 'private' },
    waitSeconds: 0,
  };
}

async function session(ctx: PublishContext, s: YtState): Promise<StepResult<YtState>> {
  if ((s.sessions ?? 0) >= MAX_SESSIONS)
    return {
      kind: 'error',
      class: 'permanent',
      code: 'yt_session_loop',
      message: 'YouTube yükleme oturumu tekrar tekrar düştü',
    };
  const size = ctx.video.size_bytes;
  const title = parseYoutubeTitle(ctx.video);
  const body = {
    snippet: snippet(ctx, title),
    status: {
      privacyStatus: s.privacy ?? 'private',
      // HER ZAMAN açıkça gönderilir.
      selfDeclaredMadeForKids: ctx.video.made_for_kids === 1,
      containsSyntheticMedia: ctx.video.ai_generated === 1,
      embeddable: true,
    },
  };
  const res = await ctx.http.fetch(
    `${YT_UPLOAD}?uploadType=resumable&part=snippet,status`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tok(ctx)}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(size),
        'x-upload-content-type': ctx.video.mime || 'video/mp4',
      },
      body: JSON.stringify(body),
    },
    { purpose: 'youtube.session', platform: 'youtube' },
  );
  if (!res.ok)
    throw new PlatformHttpError(
      res.status,
      classifyYt(res, await readJson<GoogleError>(res), ctx.now),
    );
  const location = res.headers.get('location');
  if (!location)
    return {
      kind: 'error',
      class: 'transient',
      code: 'yt_no_location',
      message: 'YouTube oturum adresi (Location) dönmedi',
    };
  return {
    kind: 'continue',
    state: {
      ...s,
      step: 'upload',
      sessionUri: location,
      sessionAt: ctx.now.toISOString(),
      offset: 0,
      size,
      verify: false,
      sessions: (s.sessions ?? 0) + 1,
      title,
    },
    waitSeconds: 0,
  };
}

type UploadStatus =
  | { kind: 'complete'; video: { id: string; status?: { privacyStatus?: string } } }
  | { kind: 'incomplete'; offset: number }
  | { kind: 'gone' };

function parseRangeEnd(h: string | null): number {
  const m = h ? /bytes=0-(\d+)/.exec(h) : null;
  return m ? Number(m[1]) + 1 : 0;
}

/** Boş PUT `Content-Range: bytes * /TOTAL` → 308 + Range (devam) | 200/201 (tamam) | 404 (oturum düştü). */
async function queryUpload(ctx: PublishContext, s: YtState): Promise<UploadStatus> {
  const res = await ctx.http.fetch(
    s.sessionUri as string,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await tok(ctx)}`,
        'content-length': '0',
        'content-range': `bytes */${s.size}`,
      },
    },
    { purpose: 'youtube.status', platform: 'youtube' },
  );
  if (res.status === 308)
    return { kind: 'incomplete', offset: parseRangeEnd(res.headers.get('range')) };
  if (res.status === 200 || res.status === 201)
    return { kind: 'complete', video: (await readJson<{ id: string }>(res)) ?? { id: '' } };
  if (res.status === 404 || res.status === 410) return { kind: 'gone' };
  throw new PlatformHttpError(
    res.status,
    classifyYt(res, await readJson<GoogleError>(res), ctx.now),
  );
}

function done(
  s: YtState,
  video: { id: string; status?: { privacyStatus?: string } },
): StepResult<YtState> {
  return {
    kind: 'done',
    externalId: video.id,
    url: `https://www.youtube.com/shorts/${video.id}`,
    visibility: video.status?.privacyStatus ?? s.privacy ?? 'private',
    state: { ...s, commitPending: false },
  };
}

async function upload(ctx: PublishContext, s0: YtState): Promise<StepResult<YtState>> {
  let s = { ...s0 };
  const size = s.size as number;
  if (s.verify) {
    const st = await queryUpload(ctx, s);
    if (st.kind === 'complete') return done(s, st.video);
    if (st.kind === 'gone')
      return {
        kind: 'continue',
        state: { ...s, step: 'session', sessionUri: undefined, offset: 0, verify: false },
        waitSeconds: 0,
      };
    s = { ...s, offset: st.offset, verify: false };
  }
  for (let i = 0; i < CHUNKS_PER_STEP; i++) {
    const first = s.offset ?? 0;
    const last = Math.min(first + YT_CHUNK, size) - 1;
    const isLast = last === size - 1;
    const obj = await ctx.env.MEDIA.get(ctx.video.r2_key, {
      range: { offset: first, length: last - first + 1 },
    });
    if (!obj)
      return {
        kind: 'error',
        class: 'permanent',
        code: 'r2_missing',
        message: 'Video dosyası depolamada yok',
      };
    const bytes = await obj.arrayBuffer();
    if (isLast) await ctx.beginCommit({ ...s, step: 'upload' });
    let res: Response;
    try {
      res = await ctx.http.fetch(
        s.sessionUri as string,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${await tok(ctx)}`,
            'content-length': String(bytes.byteLength),
            'content-range': `bytes ${first}-${last}/${size}`,
            'content-type': ctx.video.mime || 'video/mp4',
          },
          body: bytes,
        },
        { purpose: 'youtube.chunk', platform: 'youtube' },
      );
    } catch (e) {
      if (isLast) throw e; // commitPending kalır → reconcile
      return { kind: 'error', ...classifyGeneric(e), state: { ...s, verify: true } };
    }
    if (res.status === 308) {
      s = {
        ...s,
        // Range yoksa Google'a göre hiç bayt alınmamıştır → 0.
        offset: parseRangeEnd(res.headers.get('range')),
        commitPending: false,
      };
      if (isLast) return { kind: 'continue', state: { ...s, verify: true }, waitSeconds: 0 };
      continue;
    }
    if (res.status === 200 || res.status === 201) {
      const video = (await readJson<{ id: string; status?: { privacyStatus?: string } }>(res)) ?? {
        id: '',
      };
      return done(s, video);
    }
    if (res.status === 404 || res.status === 410) {
      if (isLast) return reconcileByUploads(ctx, s);
      return {
        kind: 'continue',
        state: { ...s, step: 'session', sessionUri: undefined, offset: 0 },
        waitSeconds: 0,
      };
    }
    const c = classifyYt(res, await readJson<GoogleError>(res), ctx.now);
    if (isLast && res.status >= 500) throw new PlatformHttpError(res.status, c);
    return { kind: 'error', ...c, state: { ...s, verify: true, commitPending: false } };
  }
  return { kind: 'continue', state: s, waitSeconds: 0 };
}

/** Oturum düştüyse: kanalın yüklemeler listesinde başlık + zamanla eşle (1 + 1 birim). */
async function reconcileByUploads(ctx: PublishContext, s: YtState): Promise<StepResult<YtState>> {
  const t = await tok(ctx);
  const ch = await ytJson<{
    items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
  }>(
    ctx.http,
    t,
    'GET',
    `${YT_API}/channels?part=contentDetails&mine=true`,
    undefined,
    'youtube.reconcile_channel',
    ctx.now,
  );
  const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads)
    return {
      kind: 'error',
      class: 'action',
      code: 'commit_uncertain',
      message: 'YouTube yükleme sonucu belirsiz (kanal okunamadı)',
    };
  const list = await ytJson<{
    items?: {
      snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } };
    }[];
  }>(
    ctx.http,
    t,
    'GET',
    `${YT_API}/playlistItems?part=snippet&maxResults=10&playlistId=${encodeURIComponent(uploads)}`,
    undefined,
    'youtube.reconcile_list',
    ctx.now,
  );
  const since =
    new Date(ctx.post.commit_started_at ?? ctx.now.toISOString()).getTime() - 5 * 60_000;
  const match = (list.items ?? []).filter(
    (i) =>
      i.snippet?.title === s.title &&
      (!i.snippet?.publishedAt || new Date(i.snippet.publishedAt).getTime() >= since),
  );
  const id = match[0]?.snippet?.resourceId?.videoId;
  if (match.length === 1 && id) return done(s, { id });
  return {
    kind: 'error',
    class: 'action',
    code: 'commit_uncertain',
    message: `YouTube yükleme sonucu belirsiz (${match.length} aday). Kanalda kontrol edin.`,
  };
}

async function reconcile(ctx: PublishContext, s: YtState): Promise<StepResult<YtState>> {
  if (!s.sessionUri)
    return {
      kind: 'error',
      class: 'action',
      code: 'commit_uncertain',
      message: 'YouTube yükleme sonucu belirsiz (oturum yok)',
    };
  const st = await queryUpload(ctx, s);
  if (st.kind === 'complete') return done(s, st.video);
  if (st.kind === 'incomplete')
    return {
      kind: 'continue',
      state: { ...s, step: 'upload', offset: st.offset, verify: false, commitPending: false },
      waitSeconds: 0,
    };
  return reconcileByUploads(ctx, s);
}

/** Audit sonrası: private yüklenmiş videoyu public yap (videos.update, youtube.force-ssl). */
export async function makeYoutubePublic(
  http: HttpClient,
  token: string,
  videoId: string,
  madeForKids: boolean,
  now: Date,
): Promise<string> {
  const r = await ytJson<{ status?: { privacyStatus?: string } }>(
    http,
    token,
    'PUT',
    `${YT_API}/videos?part=status`,
    { id: videoId, status: { privacyStatus: 'public', selfDeclaredMadeForKids: madeForKids } },
    'youtube.make_public',
    now,
  );
  return r.status?.privacyStatus ?? 'public';
}

async function pkce(verifier: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

async function googleToken(http: HttpClient, params: Record<string, string>, purpose: string) {
  const res = await http.fetch(
    GOOGLE_TOKEN,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    { purpose, platform: 'youtube' },
  );
  return {
    res,
    j: await readJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    }>(res),
  };
}

export const youtubeOAuth: OAuthAdapter = {
  platform: 'youtube',
  usesPkce: true,
  missingConfig: (env) =>
    [
      !env.GOOGLE_CLIENT_ID && 'GOOGLE_CLIENT_ID',
      !env.GOOGLE_CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
    ].filter((x): x is string => !!x),
  async authorizeUrl(env, state, verifier, redirectUri) {
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', YT_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    // Her bağlantıda refresh token + kanal/hesap seçimi.
    u.searchParams.set('prompt', 'consent select_account');
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', state);
    if (verifier) {
      u.searchParams.set('code_challenge', await pkce(verifier));
      u.searchParams.set('code_challenge_method', 'S256');
    }
    return u.toString();
  },
  async exchange(env, http, _log, code, verifier, redirectUri, now) {
    const { res, j } = await googleToken(
      http,
      {
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        ...(verifier ? { code_verifier: verifier } : {}),
      },
      'youtube.oauth_code',
    );
    if (!res.ok || !j?.access_token)
      throw new OAuthError(
        'yt_code',
        j?.error_description ?? `Google kod takası başarısız (${res.status})`,
      );
    if (!j.refresh_token)
      throw new OAuthError(
        'yt_no_refresh',
        'Google refresh token vermedi: Google hesabınızda uygulama erişimini kaldırıp yeniden bağlayın',
      );
    return {
      tokens: { access_token: j.access_token, refresh_token: j.refresh_token },
      token_expires_at: expiresAt(now, j.expires_in ?? 3600),
      refresh_expires_at: null,
      scopes: j.scope ?? YT_SCOPES.join(' '),
    };
  },
  async profile(_env, http, tokens) {
    const r = await ytJson<{
      items?: {
        id: string;
        snippet?: {
          title?: string;
          customUrl?: string;
          thumbnails?: { default?: { url?: string } };
        };
      }[];
    }>(
      http,
      tokens.access_token,
      'GET',
      `${YT_API}/channels?part=snippet&mine=true`,
      undefined,
      'youtube.profile',
      new Date(),
    );
    const ch = r.items?.[0];
    if (!ch) throw new OAuthError('yt_no_channel', 'Seçilen Google hesabında YouTube kanalı yok');
    return {
      external_id: ch.id,
      username: ch.snippet?.customUrl?.replace(/^@/, '') ?? null,
      display_name: ch.snippet?.title ?? null,
      avatar_url: ch.snippet?.thumbnails?.default?.url ?? null,
      meta: { channels_returned: r.items?.length ?? 0 },
    };
  },
};

export const youtubePublisher: Publisher<YtState> = {
  name: 'youtube',
  /** access token ~1 saat: bitişe 10 dk kala yenile. */
  refreshLeadSeconds: 10 * 60,
  validate: () => [],
  initialState: () => ({ step: 'quota' }),
  async step(ctx, s) {
    switch (s.step) {
      case 'quota':
        return quota(ctx, s);
      case 'session':
        return session(ctx, s);
      case 'upload':
        return upload(ctx, s);
    }
  },
  reconcile,
  classifyError: classifyGeneric,
  async refreshToken({ env, http, tokens, now }) {
    if (!tokens.refresh_token) return { ok: false, permanent: true, message: 'Refresh token yok' };
    const { res, j } = await googleToken(
      http,
      {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      },
      'youtube.refresh',
    );
    if (res.ok && j?.access_token) {
      return {
        ok: true,
        update: {
          tokens: {
            ...tokens,
            access_token: j.access_token,
            refresh_token: j.refresh_token ?? tokens.refresh_token,
          },
          token_expires_at: expiresAt(now, j.expires_in ?? 3600),
        },
      };
    }
    // invalid_grant: iptal edildi veya consent "Testing" modunda 7 gün doldu.
    return {
      ok: false,
      permanent: j?.error === 'invalid_grant' || res.status === 401,
      message:
        j?.error === 'invalid_grant'
          ? 'Google yetkisi geçersiz (iptal edildi veya Testing modunda 7 gün doldu)'
          : (j?.error_description ?? `Google yenileme başarısız (${res.status})`),
    };
  },
  async fetchMetrics(ctx, ids) {
    const out = new Map<
      string,
      {
        views: number;
        likes: number;
        comments: number;
        shares: number;
        saves: number;
        raw: unknown;
      }
    >();
    const t = ((await ctx.tokens()) as AccountTokens).access_token;
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      if (
        !(await ctx.quota.use(
          'youtube',
          'project',
          pacificDay(ctx.now),
          'units',
          1,
          QUOTAS.youtube.unitsPerDay.value,
        ))
      )
        break;
      const r = await ytJson<{
        items?: {
          id: string;
          statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
        }[];
      }>(
        ctx.http,
        t,
        'GET',
        `${YT_API}/videos?part=statistics&id=${batch.map(encodeURIComponent).join(',')}`,
        undefined,
        'youtube.metrics',
        ctx.now,
      );
      for (const v of r.items ?? []) {
        out.set(v.id, {
          views: Number(v.statistics?.viewCount ?? 0),
          likes: Number(v.statistics?.likeCount ?? 0),
          comments: Number(v.statistics?.commentCount ?? 0),
          shares: 0,
          saves: 0,
          raw: v.statistics ?? {},
        });
      }
    }
    return out;
  },
};
