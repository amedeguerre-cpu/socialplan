/**
 * TikTok — Content Posting API, "Upload" (inbox / taslağa gönder) modu, scope video.upload.
 * Akış: creator_info (süre sınırı) → inbox init (FILE_UPLOAD) → parçalı PUT → status/fetch → SEND_TO_USER_INBOX.
 * Kullanıcı TikTok uygulamasında tek dokunuşla yayınlar; post panelden "Yayınladım" ya da webhook ile kapanır.
 * Direct Post (video.publish) bilinçli olarak yazılmadı (audit'siz istemci yalnız SELF_ONLY paylaşabilir).
 * Kaynak (arama özetleriyle 31.10–05.11.2026):
 *  https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *  https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 */
import type { AccountTokens } from '../lib/tokens';
import { expiresAt, OAuthError, type OAuthAdapter } from '../oauth/types';
import { classifyGeneric, PlatformHttpError, type ClassifiedError } from './errors';
import { readJson, retryAfterSeconds, type HttpClient } from './http';
import {
  AUTH_EXPIRED,
  type BaseState,
  type PublishContext,
  type Publisher,
  type StepResult,
} from './types';

export const TT_API = 'https://open.tiktokapis.com';
const TT_SCOPES = ['user.info.basic', 'video.upload', 'video.list'];
const MB = 1024 * 1024;
/** Parça: ≥5 MB, ≤64 MB; son parça ≤128 MB (kalanı emer). */
export const TT_CHUNK = 10 * MB;
const CHUNKS_PER_STEP = 4;
/** upload_url 1 saat geçerli; güvenlik payıyla 55 dk. */
const UPLOAD_URL_TTL_MS = 55 * 60_000;
const STATUS_WAIT_SEC = 10;
const STATUS_CEILING_MS = 30 * 60_000;

export interface TtState extends BaseState {
  step: 'creator_info' | 'init' | 'upload' | 'status';
  maxDurationSec?: number | null;
  publishId?: string;
  uploadUrl?: string;
  uploadUrlAt?: string;
  videoSize?: number;
  chunkSize?: number;
  totalChunks?: number;
  nextChunk?: number;
  uploadedAt?: string;
  inits?: number;
}

interface TtBody<T> {
  data?: T;
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * Parça planı (TikTok FILE_UPLOAD): ≤ 64 MB tek parça (chunk_size = video_size); büyükte 10 MiB
 * (1000 parça tavanı için gerekirse büyütülür), total_chunk_count = floor(size / chunk), son parça kalanı
 * emer (< 2 × chunk ≤ 128 MB). Eski hata: 5–10 MB arası dosyada chunk_size > video_size bildiriliyordu.
 */
export function chunkPlan(
  size: number,
  chunk = TT_CHUNK,
): { chunkSize: number; totalChunks: number } {
  if (size <= 64 * MB) return { chunkSize: size, totalChunks: 1 };
  const c = Math.max(chunk, Math.ceil(size / 1000));
  return { chunkSize: c, totalChunks: Math.max(1, Math.floor(size / c)) };
}

/** n. parçanın bayt aralığı (son parça kalanı alır). */
export function chunkRange(
  n: number,
  size: number,
  chunkSize: number,
  total: number,
): { first: number; last: number } {
  const first = n * chunkSize;
  const last = n === total - 1 ? size - 1 : first + chunkSize - 1;
  return { first, last };
}

export function classifyTt(res: Response, body: TtBody<unknown> | null): ClassifiedError {
  const code = body?.error?.code;
  const msg = `TikTok: ${body?.error?.message || code || `HTTP ${res.status}`}`;
  if (code === 'access_token_invalid' || res.status === 401)
    return { class: 'transient', code: AUTH_EXPIRED, message: msg };
  if (code === 'rate_limit_exceeded' || res.status === 429)
    return {
      class: 'transient',
      code: 'rate_limited',
      message: msg,
      retryAfterSec: retryAfterSeconds(res) ?? 60,
    };
  if (
    code === 'spam_risk_too_many_pending_share' ||
    code === 'spam_risk_user_banned_from_posting' ||
    code === 'spam_risk'
  ) {
    return {
      class: 'action',
      code: `tt_${code}`,
      message: `${msg} (gelen kutusunda bekleyen taslakları yayınlayın veya silin)`,
    };
  }
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed')
    return {
      class: 'action',
      code: 'tt_scope',
      message: `${msg} (video.upload izni gerekli; yeniden bağlayın)`,
    };
  if (code === 'unaudited_client_can_only_post_to_private_accounts')
    return { class: 'action', code: `tt_${code}`, message: msg };
  if (code === 'internal_error' || res.status >= 500)
    return { class: 'transient', code: `tt_${code ?? res.status}`, message: msg };
  return { class: 'permanent', code: `tt_${code ?? res.status}`, message: msg };
}

async function ttPost<T>(
  http: HttpClient,
  token: string,
  path: string,
  body: unknown,
  purpose: string,
): Promise<T> {
  const res = await http.fetch(
    `${TT_API}${path}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(body ?? {}),
    },
    { purpose, platform: 'tiktok' },
  );
  const j = await readJson<TtBody<T>>(res);
  if (!res.ok || (j?.error?.code && j.error.code !== 'ok'))
    throw new PlatformHttpError(res.status, classifyTt(res, j));
  return (j?.data ?? {}) as T;
}

const tok = async (ctx: PublishContext): Promise<string> => (await ctx.tokens()).access_token;

async function creatorInfo(ctx: PublishContext, s: TtState): Promise<StepResult<TtState>> {
  let max: number | null = null;
  try {
    const d = await ttPost<{ max_video_post_duration_sec?: number; creator_username?: string }>(
      ctx.http,
      await tok(ctx),
      '/v2/post/publish/creator_info/query/',
      {},
      'tiktok.creator_info',
    );
    max = d.max_video_post_duration_sec ?? null;
  } catch (e) {
    // TODO(doğrula): creator_info yalnız video.publish scope'uyla mı çalışıyor? Scope hatasında süre denetimi atlanır.
    if (!(e instanceof PlatformHttpError && e.classified.code === 'tt_scope')) throw e;
    ctx.log.warn('tiktok.creator_info_skipped', { reason: 'scope' });
  }
  if (max && ctx.video.duration_ms && ctx.video.duration_ms / 1000 > max) {
    return {
      kind: 'error',
      class: 'permanent',
      code: 'tt_duration',
      message: `TikTok: süre ${Math.round(ctx.video.duration_ms / 1000)} sn, hesabın sınırı ${max} sn`,
    };
  }
  return { kind: 'continue', state: { ...s, step: 'init', maxDurationSec: max }, waitSeconds: 0 };
}

async function init(ctx: PublishContext, s: TtState): Promise<StepResult<TtState>> {
  const size = ctx.video.size_bytes;
  const plan = chunkPlan(size);
  // TODO(doğrula): inbox modunda post_info (caption) ve is_aigc kabul ediliyor mu? Şimdilik yalnız source_info; caption bildirimde.
  const d = await ttPost<{ publish_id: string; upload_url: string }>(
    ctx.http,
    await tok(ctx),
    '/v2/post/publish/inbox/video/init/',
    {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunks,
      },
    },
    'tiktok.init',
  );
  return {
    kind: 'continue',
    state: {
      ...s,
      step: 'upload',
      publishId: d.publish_id,
      uploadUrl: d.upload_url,
      uploadUrlAt: ctx.now.toISOString(),
      videoSize: size,
      chunkSize: plan.chunkSize,
      totalChunks: plan.totalChunks,
      nextChunk: 0,
      inits: (s.inits ?? 0) + 1,
    },
    waitSeconds: 0,
  };
}

async function upload(ctx: PublishContext, s: TtState): Promise<StepResult<TtState>> {
  const size = s.videoSize as number;
  const total = s.totalChunks as number;
  const chunkSize = s.chunkSize as number;
  if (ctx.now.getTime() - new Date(s.uploadUrlAt ?? 0).getTime() > UPLOAD_URL_TTL_MS) {
    if ((s.inits ?? 0) >= 3)
      return {
        kind: 'error',
        class: 'transient',
        code: 'tt_upload_url_expired',
        message: 'TikTok yükleme adresinin süresi tekrar tekrar doldu',
      };
    return {
      kind: 'continue',
      state: { ...s, step: 'init', publishId: undefined, uploadUrl: undefined, nextChunk: 0 },
      waitSeconds: 0,
    };
  }
  let state: TtState = { ...s };
  for (let i = 0; i < CHUNKS_PER_STEP && (state.nextChunk ?? 0) < total; i++) {
    const n = state.nextChunk ?? 0;
    const { first, last } = chunkRange(n, size, chunkSize, total);
    const isLast = n === total - 1;
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
    // Son parça gönderilince video gelen kutusuna düşer: geri dönüşsüz.
    if (isLast) await ctx.beginCommit({ ...state, step: 'upload' });
    const res = await ctx.http.fetch(
      state.uploadUrl as string,
      {
        method: 'PUT',
        headers: {
          'content-type': ctx.video.mime || 'video/mp4',
          'content-length': String(bytes.byteLength),
          'content-range': `bytes ${first}-${last}/${size}`,
        },
        body: bytes,
      },
      { purpose: 'tiktok.chunk', platform: 'tiktok' },
    );
    if (res.status === 403) {
      // upload_url doldu → parça alınmadı (son parça da olsa yükleme tamamlanmadı) → yeniden init
      return {
        kind: 'continue',
        state: {
          ...state,
          step: 'init',
          publishId: undefined,
          uploadUrl: undefined,
          nextChunk: 0,
          commitPending: false,
        },
        waitSeconds: 0,
      };
    }
    if (res.status !== 206 && res.status !== 201 && res.status !== 200) {
      const body = await readJson<TtBody<unknown>>(res);
      const c = classifyTt(res, body);
      if (isLast && res.status >= 400 && res.status < 500)
        return { kind: 'error', ...c, state: { ...state, commitPending: false } };
      if (isLast) throw new PlatformHttpError(res.status, c);
      return { kind: 'error', ...c, state };
    }
    state = { ...state, nextChunk: n + 1, commitPending: isLast ? false : state.commitPending };
    if (isLast)
      return {
        kind: 'continue',
        state: {
          ...state,
          step: 'status',
          uploadedAt: ctx.now.toISOString(),
          commitPending: false,
        },
        waitSeconds: 5,
      };
  }
  return { kind: 'continue', state, waitSeconds: 0 };
}

async function status(ctx: PublishContext, s: TtState): Promise<StepResult<TtState>> {
  const d = await ttPost<{
    status?: string;
    fail_reason?: string;
    publicaly_available_post_id?: (string | number)[];
  }>(
    ctx.http,
    await tok(ctx),
    '/v2/post/publish/status/fetch/',
    { publish_id: s.publishId },
    'tiktok.status',
  );
  switch (d.status) {
    case 'SEND_TO_USER_INBOX':
      return {
        kind: 'inbox',
        state: { ...s, commitPending: false },
        externalId: s.publishId ?? null,
      };
    case 'PUBLISH_COMPLETE': {
      const postId = d.publicaly_available_post_id?.[0];
      return {
        kind: 'done',
        externalId: s.publishId as string,
        url: postId
          ? `https://www.tiktok.com/@${ctx.account.username ?? ''}/video/${postId}`
          : null,
        visibility: 'public',
        state: { ...s, commitPending: false, post_id: postId ? String(postId) : undefined },
      };
    }
    case 'FAILED':
      return {
        kind: 'error',
        class: 'permanent',
        code: 'tt_failed',
        message: `TikTok işleyemedi: ${d.fail_reason ?? 'bilinmiyor'}`,
        state: { ...s, commitPending: false },
      };
    default: {
      const since = new Date(s.uploadedAt ?? ctx.now.toISOString()).getTime();
      if (ctx.now.getTime() - since > STATUS_CEILING_MS) {
        return {
          kind: 'error',
          class: 'action',
          code: 'commit_uncertain',
          message: `TikTok durumu 30 dk içinde kesinleşmedi (${d.status ?? '?'})`,
        };
      }
      return { kind: 'continue', state: s, waitSeconds: STATUS_WAIT_SEC };
    }
  }
}

/** Son parça yanıtı kayboldu: publish_id durumuna bak; asla kör retry. */
async function reconcile(ctx: PublishContext, s: TtState): Promise<StepResult<TtState>> {
  if (!s.publishId)
    return {
      kind: 'error',
      class: 'action',
      code: 'commit_uncertain',
      message: 'TikTok yükleme sonucu belirsiz (publish_id yok)',
    };
  const d = await ttPost<{ status?: string; fail_reason?: string }>(
    ctx.http,
    await tok(ctx),
    '/v2/post/publish/status/fetch/',
    { publish_id: s.publishId },
    'tiktok.reconcile',
  );
  if (
    d.status === 'SEND_TO_USER_INBOX' ||
    d.status === 'PUBLISH_COMPLETE' ||
    d.status === 'PROCESSING_UPLOAD'
  ) {
    return {
      kind: 'continue',
      state: {
        ...s,
        step: 'status',
        commitPending: false,
        uploadedAt: s.uploadedAt ?? ctx.now.toISOString(),
      },
      waitSeconds: d.status === 'PROCESSING_UPLOAD' ? STATUS_WAIT_SEC : 0,
    };
  }
  if (d.status === 'FAILED')
    return {
      kind: 'error',
      class: 'permanent',
      code: 'tt_failed',
      message: `TikTok işleyemedi: ${d.fail_reason ?? ''}`,
      state: { ...s, commitPending: false },
    };
  return {
    kind: 'error',
    class: 'action',
    code: 'commit_uncertain',
    message: `TikTok yükleme sonucu belirsiz (${d.status ?? '?'})`,
  };
}

async function tokenRequest(http: HttpClient, params: Record<string, string>, purpose: string) {
  const res = await http.fetch(
    `${TT_API}/v2/oauth/token/`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    },
    { purpose, platform: 'tiktok' },
  );
  const j = await readJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_expires_in?: number;
    open_id?: string;
    scope?: string;
    error?: string | { code?: string };
    error_description?: string;
  }>(res);
  return { res, j };
}

export const tiktokOAuth: OAuthAdapter = {
  platform: 'tiktok',
  usesPkce: false, // web'de PKCE yok; state ile korunur
  missingConfig: (env) =>
    [
      !env.TIKTOK_CLIENT_KEY && 'TIKTOK_CLIENT_KEY',
      !env.TIKTOK_CLIENT_SECRET && 'TIKTOK_CLIENT_SECRET',
    ].filter((x): x is string => !!x),
  async authorizeUrl(env, state, _v, redirectUri) {
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.searchParams.set('client_key', env.TIKTOK_CLIENT_KEY);
    u.searchParams.set('scope', TT_SCOPES.join(','));
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('response_type', 'code');
    return u.toString();
  },
  async exchange(env, http, _log, code, _v, redirectUri, now) {
    const { res, j } = await tokenRequest(
      http,
      {
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET ?? '',
        code: decodeURIComponent(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
      'tiktok.oauth_code',
    );
    if (!res.ok || !j?.access_token)
      throw new OAuthError(
        'tt_code',
        j?.error_description ?? `TikTok kod takası başarısız (${res.status})`,
      );
    // Ömürler sayfalar arasında çelişiyor: yanıttaki expires_in / refresh_expires_in kullanılır.
    return {
      tokens: { access_token: j.access_token, refresh_token: j.refresh_token, open_id: j.open_id },
      token_expires_at: expiresAt(now, j.expires_in),
      refresh_expires_at: expiresAt(now, j.refresh_expires_in),
      scopes: j.scope ?? TT_SCOPES.join(','),
    };
  },
  async profile(_env, http, tokens) {
    const res = await http.fetch(
      `${TT_API}/v2/user/info/?fields=open_id,union_id,avatar_url,display_name,username`,
      { method: 'GET', headers: { authorization: `Bearer ${tokens.access_token}` } },
      { purpose: 'tiktok.profile', platform: 'tiktok' },
    );
    const j = await readJson<
      TtBody<{
        user?: {
          open_id?: string;
          avatar_url?: string;
          display_name?: string;
          username?: string;
        };
      }>
    >(res);
    const u = j?.data?.user;
    const openId = u?.open_id ?? (tokens.open_id as string | undefined);
    if (!openId)
      throw new OAuthError(
        'tt_profile',
        `TikTok profil alınamadı (${j?.error?.message ?? res.status})`,
      );
    return {
      external_id: openId,
      username: u?.username ?? null,
      display_name: u?.display_name ?? null,
      avatar_url: u?.avatar_url ?? null,
      meta: {},
    };
  },
};

export const tiktokPublisher: Publisher<TtState> = {
  name: 'tiktok',
  /** access token kısa ömürlü: bitişe 2 saat kala yenile. */
  refreshLeadSeconds: 2 * 3600,
  validate: () => [],
  initialState: () => ({ step: 'creator_info' }),
  async step(ctx, s) {
    switch (s.step) {
      case 'creator_info':
        return creatorInfo(ctx, s);
      case 'init':
        return init(ctx, s);
      case 'upload':
        return upload(ctx, s);
      case 'status':
        return status(ctx, s);
    }
  },
  reconcile,
  classifyError: classifyGeneric,
  async refreshToken({ env, http, tokens, now, account }) {
    if (!tokens.refresh_token) return { ok: false, permanent: true, message: 'Refresh token yok' };
    if (
      account.refresh_expires_at &&
      new Date(account.refresh_expires_at).getTime() < now.getTime()
    ) {
      return { ok: false, permanent: true, message: 'TikTok refresh token süresi doldu' };
    }
    const { res, j } = await tokenRequest(
      http,
      {
        client_key: env.TIKTOK_CLIENT_KEY,
        client_secret: env.TIKTOK_CLIENT_SECRET ?? '',
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      },
      'tiktok.refresh',
    );
    if (res.ok && j?.access_token) {
      return {
        ok: true,
        update: {
          tokens: {
            ...tokens,
            access_token: j.access_token,
            refresh_token: j.refresh_token ?? tokens.refresh_token,
            open_id: j.open_id ?? tokens.open_id,
          },
          token_expires_at: expiresAt(now, j.expires_in),
          refresh_expires_at: expiresAt(now, j.refresh_expires_in),
          scopes: j.scope,
        },
      };
    }
    return {
      ok: false,
      permanent: res.status === 400 || res.status === 401,
      message: j?.error_description ?? `TikTok yenileme başarısız (${res.status})`,
    };
  },
  async fetchMetrics(ctx, externalIds) {
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
    const t = (await ctx.tokens()) as AccountTokens;
    for (let i = 0; i < externalIds.length; i += 20) {
      const ids = externalIds.slice(i, i + 20);
      const res = await ctx.http.fetch(
        `${TT_API}/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${t.access_token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ filters: { video_ids: ids } }),
        },
        { purpose: 'tiktok.metrics', platform: 'tiktok' },
      );
      const j = await readJson<
        TtBody<{
          videos?: {
            id: string;
            view_count?: number;
            like_count?: number;
            comment_count?: number;
            share_count?: number;
          }[];
        }>
      >(res);
      if (!res.ok) {
        ctx.log.warn('tiktok.metrics_failed', { status: res.status });
        continue;
      }
      for (const v of j?.data?.videos ?? []) {
        out.set(v.id, {
          views: v.view_count ?? 0,
          likes: v.like_count ?? 0,
          comments: v.comment_count ?? 0,
          shares: v.share_count ?? 0,
          saves: 0,
          raw: v,
        });
      }
    }
    return out;
  },
};
