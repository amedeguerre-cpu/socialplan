/**
 * Instagram Reels — "Instagram API with Instagram Login" (graph.instagram.com).
 * Akış: yayın limiti → container (video_url veya resumable) → durum yoklama → media_publish (commit) → permalink.
 * Kaynak (arama özetleriyle doğrulandı 31.10–05.11.2026):
 *  https://developers.facebook.com/docs/instagram-platform/content-publishing
 *  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 */
import { parseJson } from '../lib/db';
import { presignGet } from '../lib/r2';
import type { AccountTokens } from '../lib/tokens';
import { expiresAt, OAuthError, type OAuthAdapter } from '../oauth/types';
import { classifyGeneric, classifyStatus, PlatformHttpError, type ClassifiedError } from './errors';
import { readJson, type HttpClient } from './http';
import {
  AUTH_EXPIRED,
  type BaseState,
  type PublishContext,
  type Publisher,
  type StepResult,
} from './types';

/** Graph API sürümü — TEK sabit. */
export const IG_API_VERSION = 'v26.0';
export const IG_GRAPH = 'https://graph.instagram.com';
const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_insights',
];

const FIRST_POLL_SEC = 20;
const POLL_SEC = 30;
const POLL_CEILING_MS = 20 * 60_000;
const LIMIT_WAIT_SEC = 3600;
const MAX_LIMIT_WAITS = 24;

export type IgUploadMode = 'video_url' | 'resumable';

export interface IgState extends BaseState {
  step: 'limit' | 'create' | 'upload' | 'poll' | 'publish' | 'permalink';
  containerId?: string;
  uploadUri?: string;
  containerCreatedAt?: string;
  polls?: number;
  limitWaits?: number;
  mediaId?: string;
  publishStartedAt?: string;
}

interface GraphError {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
  };
}

/** Graph API hata gövdesini sınıflandır. */
export function classifyIg(res: Response, body: GraphError | null): ClassifiedError {
  const e = body?.error;
  const msg = e?.message ? `Instagram: ${e.message}` : `Instagram HTTP ${res.status}`;
  const code = e?.code;
  const sub = e?.error_subcode;
  if (code === 190 || res.status === 401)
    return { class: 'transient', code: AUTH_EXPIRED, message: msg };
  // 100/33: aralıklı "nesne yok" — container henüz görünmüyor olabilir (geçici sayılır).
  if (code === 100 && sub === 33)
    return { class: 'transient', code: 'ig_100_33', message: msg, retryAfterSec: 30 };
  if (code === 9 && sub === 2207042)
    return {
      class: 'transient',
      code: 'ig_publish_limit',
      message: msg,
      retryAfterSec: LIMIT_WAIT_SEC,
    };
  if (code === 4 || code === 17 || code === 32 || code === 613 || res.status === 429) {
    return { class: 'transient', code: 'rate_limited', message: msg, retryAfterSec: 600 };
  }
  if (e?.is_transient || code === 1 || code === 2 || res.status >= 500)
    return { class: 'transient', code: `ig_${code ?? res.status}`, message: msg };
  if (code === 10 || code === 200 || (code !== undefined && code >= 200 && code < 300)) {
    return {
      class: 'action',
      code: 'ig_permission',
      message: `${msg} (izin/hesap türü: Business veya Creator hesap ve scope'ları kontrol edin)`,
    };
  }
  if (code === 368) return { class: 'action', code: 'ig_restricted', message: msg };
  return classifyStatus(
    res,
    msg,
    code !== undefined ? `ig_${code}${sub ? `_${sub}` : ''}` : undefined,
  );
}

async function graph<T>(
  http: HttpClient,
  token: string,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string | undefined> = {},
  purpose = 'instagram',
): Promise<T> {
  const url = new URL(`${IG_GRAPH}/${IG_API_VERSION}/${path.replace(/^\//, '')}`);
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  let init: RequestInit;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, v);
    init = { method, headers: { authorization: `Bearer ${token}` } };
  } else {
    init = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(clean).toString(),
    };
  }
  const res = await http.fetch(url.toString(), init, { purpose, platform: 'instagram' });
  const body = await readJson<T & GraphError>(res);
  if (!res.ok || body?.error) throw new PlatformHttpError(res.status, classifyIg(res, body));
  return body as T;
}

function igUserId(ctx: PublishContext): string {
  return ctx.account.external_id;
}

function uploadMode(ctx: PublishContext): IgUploadMode {
  const m = parseJson<{ ig_upload_mode?: IgUploadMode }>(ctx.account.meta, {});
  return m.ig_upload_mode === 'resumable' ? 'resumable' : 'video_url';
}

async function token(ctx: PublishContext): Promise<string> {
  return (await ctx.tokens()).access_token;
}

/** Yayın kotası (24 sa kayan pencere) — sabit yazılmaz, API'den okunur ve hesap meta'sına yazılır. */
async function checkLimit(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  const r = await graph<{
    data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
  }>(
    ctx.http,
    await token(ctx),
    'GET',
    `${igUserId(ctx)}/content_publishing_limit`,
    { fields: 'quota_usage,config' },
    'instagram.limit',
  );
  const d = r.data?.[0];
  const usage = d?.quota_usage ?? 0;
  const total = d?.config?.quota_total ?? null;
  const meta = parseJson<Record<string, unknown>>(ctx.account.meta, {});
  meta.publishing_limit = {
    quota_usage: usage,
    quota_total: total,
    fetched_at: ctx.now.toISOString(),
  };
  await ctx.env.DB.prepare('UPDATE accounts SET meta = ? WHERE id = ?')
    .bind(JSON.stringify(meta), ctx.account.id)
    .run();
  if (total !== null && usage >= total) {
    const waits = (s.limitWaits ?? 0) + 1;
    if (waits > MAX_LIMIT_WAITS)
      return {
        kind: 'error',
        class: 'action',
        code: 'ig_publish_limit',
        message: `Instagram 24 saatlik yayın limiti dolu (${usage}/${total})`,
      };
    ctx.log.warn('instagram.limit_reached', { usage, total });
    return {
      kind: 'continue',
      state: { ...s, step: 'limit', limitWaits: waits },
      waitSeconds: LIMIT_WAIT_SEC,
    };
  }
  return { kind: 'continue', state: { ...s, step: 'create' }, waitSeconds: 0 };
}

async function createContainer(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  const mode = uploadMode(ctx);
  const common: Record<string, string | undefined> = {
    media_type: 'REELS',
    caption: ctx.caption,
    share_to_feed: 'true',
    // TODO(doğrula): is_ai_generated parametresinin adı/geçerliliği (Meta AI etiketi).
    is_ai_generated: ctx.video.ai_generated ? 'true' : undefined,
  };
  if (ctx.video.thumbnail_key) {
    const cover = await presignGet(ctx.env, ctx.video.thumbnail_key, 6 * 3600);
    if (cover) common.cover_url = cover;
  } else {
    common.thumb_offset = '1000';
  }
  if (mode === 'video_url') {
    // TODO(doğrula): Meta'nın query string'li, süreli R2 presigned URL'sini kabul etmesi. Olmazsa hesap meta'sında ig_upload_mode=resumable.
    const videoUrl = await presignGet(ctx.env, ctx.video.r2_key, 6 * 3600);
    if (!videoUrl)
      return {
        kind: 'error',
        class: 'permanent',
        code: 'no_public_url',
        message: 'R2 S3 anahtarı yok: Instagram için video_url üretilemedi',
      };
    const r = await graph<{ id: string }>(
      ctx.http,
      await token(ctx),
      'POST',
      `${igUserId(ctx)}/media`,
      { ...common, video_url: videoUrl },
      'instagram.create',
    );
    return {
      kind: 'continue',
      state: {
        ...s,
        step: 'poll',
        containerId: r.id,
        containerCreatedAt: ctx.now.toISOString(),
        polls: 0,
      },
      waitSeconds: FIRST_POLL_SEC,
    };
  }
  const r = await graph<{ id: string; uri?: string }>(
    ctx.http,
    await token(ctx),
    'POST',
    `${igUserId(ctx)}/media`,
    { ...common, upload_type: 'resumable' },
    'instagram.create_resumable',
  );
  const uri = r.uri ?? `https://rupload.facebook.com/ig-api-upload/${IG_API_VERSION}/${r.id}`;
  return {
    kind: 'continue',
    state: {
      ...s,
      step: 'upload',
      containerId: r.id,
      uploadUri: uri,
      containerCreatedAt: ctx.now.toISOString(),
      polls: 0,
    },
    waitSeconds: 0,
  };
}

/** Resumable: R2'den akışla tek istekte gönder (128 MB belleğe sığdırmadan). */
async function resumableUpload(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  const obj = await ctx.env.MEDIA.get(ctx.video.r2_key);
  if (!obj)
    return {
      kind: 'error',
      class: 'permanent',
      code: 'r2_missing',
      message: 'Video dosyası depolamada yok',
    };
  const fixed = new FixedLengthStream(obj.size);
  void obj.body.pipeTo(fixed.writable).catch(() => undefined);
  // TODO(doğrula): rupload kesintide `offset` başlığıyla kaldığı yerden devam; şimdilik baştan gönderilir.
  const res = await ctx.http.fetch(
    s.uploadUri as string,
    {
      method: 'POST',
      headers: {
        authorization: `OAuth ${await token(ctx)}`,
        offset: '0',
        file_size: String(obj.size),
        'content-type': 'application/octet-stream',
      },
      body: fixed.readable,
    },
    { purpose: 'instagram.rupload', platform: 'instagram' },
  );
  const body = await readJson<GraphError & { success?: boolean }>(res);
  if (!res.ok || body?.error) throw new PlatformHttpError(res.status, classifyIg(res, body));
  return { kind: 'continue', state: { ...s, step: 'poll' }, waitSeconds: FIRST_POLL_SEC };
}

async function poll(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  let r: { status_code?: string; status?: string };
  try {
    r = await graph(
      ctx.http,
      await token(ctx),
      'GET',
      s.containerId as string,
      { fields: 'status_code,status' },
      'instagram.poll',
    );
  } catch (e) {
    const c = classifyGeneric(e);
    if (c.code === 'ig_100_33')
      return {
        kind: 'continue',
        state: { ...s, polls: (s.polls ?? 0) + 1 },
        waitSeconds: POLL_SEC,
      };
    throw e;
  }
  const elapsed =
    ctx.now.getTime() - new Date(s.containerCreatedAt ?? ctx.now.toISOString()).getTime();
  switch (r.status_code) {
    case 'FINISHED':
      return { kind: 'continue', state: { ...s, step: 'publish' }, waitSeconds: 0 };
    case 'PUBLISHED':
      // Commit'ten önce PUBLISHED görülmesi beklenmez; reconcile ile eşle.
      return reconcile(ctx, { ...s, step: 'publish', commitPending: true });
    case 'ERROR':
      return {
        kind: 'error',
        class: 'permanent',
        code: 'ig_container_error',
        message: `Instagram videoyu işleyemedi: ${r.status ?? 'ERROR'}`,
        state: { ...s, step: 'create', containerId: undefined },
      };
    case 'EXPIRED':
      // 24 saat içinde yayınlanmayan container düşer: yeniden oluştur.
      return {
        kind: 'continue',
        state: { ...s, step: 'create', containerId: undefined, polls: 0 },
        waitSeconds: 0,
      };
    default:
      if (elapsed > POLL_CEILING_MS) {
        return {
          kind: 'error',
          class: 'transient',
          code: 'ig_poll_timeout',
          message: 'Instagram işleme 20 dk içinde bitmedi',
          state: { ...s, step: 'create', containerId: undefined },
        };
      }
      return {
        kind: 'continue',
        state: { ...s, polls: (s.polls ?? 0) + 1 },
        waitSeconds: POLL_SEC,
      };
  }
}

async function publish(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  const pending: IgState = { ...s, step: 'publish', publishStartedAt: ctx.now.toISOString() };
  await ctx.beginCommit(pending);
  try {
    const r = await graph<{ id: string }>(
      ctx.http,
      await token(ctx),
      'POST',
      `${igUserId(ctx)}/media_publish`,
      { creation_id: s.containerId },
      'instagram.publish',
    );
    return {
      kind: 'continue',
      state: { ...pending, step: 'permalink', mediaId: r.id, commitPending: false },
      waitSeconds: 0,
    };
  } catch (e) {
    // Kesin 4xx yanıtı = yayın olmadı → commit kalkar. Ağ hatası/5xx = belirsiz → commitPending kalır (reconcile).
    if (
      e instanceof PlatformHttpError &&
      e.status >= 400 &&
      e.status < 500 &&
      e.classified.code !== AUTH_EXPIRED
    ) {
      return { kind: 'error', ...e.classified, state: { ...pending, commitPending: false } };
    }
    throw e;
  }
}

async function permalink(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  const r = await graph<{ id: string; permalink?: string; media_product_type?: string }>(
    ctx.http,
    await token(ctx),
    'GET',
    s.mediaId as string,
    { fields: 'permalink,media_product_type' },
    'instagram.permalink',
  );
  return {
    kind: 'done',
    externalId: s.mediaId as string,
    url: r.permalink ?? null,
    visibility: 'public',
    state: { ...s, commitPending: false },
  };
}

const norm = (t: string | undefined | null): string => (t ?? '').replace(/\s+/g, ' ').trim();

/** Commit sonucu belirsiz: container durumu + son medyalarda caption/zaman eşlemesi. */
async function reconcile(ctx: PublishContext, s: IgState): Promise<StepResult<IgState>> {
  if (s.mediaId) return permalink(ctx, s);
  if (!s.containerId)
    return {
      kind: 'error',
      class: 'action',
      code: 'commit_uncertain',
      message: 'Instagram yayın sonucu belirsiz (container yok)',
    };
  const st = await graph<{ status_code?: string }>(
    ctx.http,
    await token(ctx),
    'GET',
    s.containerId,
    { fields: 'status_code' },
    'instagram.reconcile_status',
  );
  if (st.status_code === 'FINISHED') {
    // Yayınlanmamış: güvenle tekrar denenebilir.
    return {
      kind: 'continue',
      state: { ...s, step: 'publish', commitPending: false },
      waitSeconds: 0,
    };
  }
  if (st.status_code === 'PUBLISHED') {
    const since =
      new Date(
        s.publishStartedAt ?? ctx.post.commit_started_at ?? ctx.now.toISOString(),
      ).getTime() -
      2 * 60_000;
    const list = await graph<{
      data?: { id: string; caption?: string; timestamp?: string; permalink?: string }[];
    }>(
      ctx.http,
      await token(ctx),
      'GET',
      `${igUserId(ctx)}/media`,
      { fields: 'id,caption,timestamp,permalink,media_product_type', limit: '10' },
      'instagram.reconcile_list',
    );
    const match = (list.data ?? []).filter(
      (m) =>
        norm(m.caption) === norm(ctx.caption) &&
        (!m.timestamp || new Date(m.timestamp).getTime() >= since),
    );
    if (match.length === 1 && match[0]) {
      return {
        kind: 'done',
        externalId: match[0].id,
        url: match[0].permalink ?? null,
        visibility: 'public',
        state: { ...s, mediaId: match[0].id, commitPending: false },
      };
    }
    return {
      kind: 'error',
      class: 'action',
      code: 'commit_uncertain',
      message: `Instagram'da yayınlandı görünüyor ama medya eşleşmedi (${match.length} aday). Profilde kontrol edin.`,
    };
  }
  return {
    kind: 'error',
    class: 'action',
    code: 'commit_uncertain',
    message: `Instagram yayın sonucu belirsiz (container: ${st.status_code ?? '?'})`,
  };
}

async function exchangeShortForLong(
  http: HttpClient,
  secret: string,
  shortToken: string,
): Promise<{ access_token: string; expires_in?: number }> {
  const u = new URL(`${IG_GRAPH}/access_token`);
  u.searchParams.set('grant_type', 'ig_exchange_token');
  u.searchParams.set('client_secret', secret);
  u.searchParams.set('access_token', shortToken);
  const res = await http.fetch(
    u.toString(),
    { method: 'GET' },
    { purpose: 'instagram.long_token', platform: 'instagram' },
  );
  const j = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(res);
  if (!res.ok || !j?.access_token)
    throw new OAuthError(
      'ig_long_token',
      j?.error?.message ?? `Uzun ömürlü token alınamadı (${res.status})`,
    );
  return { access_token: j.access_token, expires_in: j.expires_in };
}

export const instagramOAuth: OAuthAdapter = {
  platform: 'instagram',
  usesPkce: false,
  missingConfig: (env) =>
    [!env.IG_APP_ID && 'IG_APP_ID', !env.IG_APP_SECRET && 'IG_APP_SECRET'].filter(
      (x): x is string => !!x,
    ),
  async authorizeUrl(env, state, _v, redirectUri) {
    const u = new URL('https://www.instagram.com/oauth/authorize');
    u.searchParams.set('client_id', env.IG_APP_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', IG_SCOPES.join(','));
    u.searchParams.set('state', state);
    return u.toString();
  },
  async exchange(env, http, _log, code, _v, redirectUri, now) {
    const res = await http.fetch(
      'https://api.instagram.com/oauth/access_token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.IG_APP_ID,
          client_secret: env.IG_APP_SECRET ?? '',
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code: code.replace(/#_$/, ''),
        }).toString(),
      },
      { purpose: 'instagram.oauth_code', platform: 'instagram' },
    );
    const j = await readJson<{
      access_token?: string;
      user_id?: number | string;
      permissions?: string[] | string;
      error_message?: string;
    }>(res);
    if (!res.ok || !j?.access_token)
      throw new OAuthError('ig_code', j?.error_message ?? `Kod takası başarısız (${res.status})`);
    const long = await exchangeShortForLong(http, env.IG_APP_SECRET ?? '', j.access_token);
    const perms = Array.isArray(j.permissions)
      ? j.permissions.join(',')
      : (j.permissions ?? IG_SCOPES.join(','));
    return {
      tokens: { access_token: long.access_token, user_id: String(j.user_id ?? '') },
      token_expires_at: expiresAt(now, long.expires_in ?? 60 * 86400),
      refresh_expires_at: null,
      scopes: perms,
    };
  },
  async profile(_env, http, tokens) {
    const r = await graph<{
      id?: string;
      user_id?: string | number;
      username?: string;
      name?: string;
      profile_picture_url?: string;
      account_type?: string;
    }>(
      http,
      tokens.access_token,
      'GET',
      'me',
      { fields: 'id,user_id,username,name,profile_picture_url,account_type' },
      'instagram.profile',
    );
    // TODO(doğrula): /{ig-user-id}/media için `user_id` (profesyonel hesap kimliği) mi `id` mi — user_id tercih edildi.
    const external = String(r.user_id ?? r.id ?? tokens.user_id ?? '');
    if (!external) throw new OAuthError('ig_profile', 'Instagram hesap kimliği alınamadı');
    if (r.account_type && !['BUSINESS', 'MEDIA_CREATOR', 'CREATOR'].includes(r.account_type)) {
      throw new OAuthError(
        'ig_account_type',
        `Instagram hesabı Business/Creator olmalı (şu an: ${r.account_type})`,
      );
    }
    return {
      external_id: external,
      username: r.username ?? null,
      display_name: r.name ?? null,
      avatar_url: r.profile_picture_url ?? null,
      meta: { account_type: r.account_type ?? null },
    };
  },
};

export const instagramPublisher: Publisher<IgState> = {
  name: 'instagram',
  /** Bitişe 10 gün kala yenile. */
  refreshLeadSeconds: 10 * 86400,
  validate: () => [],
  initialState: () => ({ step: 'limit' }),
  async step(ctx, s) {
    switch (s.step) {
      case 'limit':
        return checkLimit(ctx, s);
      case 'create':
        return createContainer(ctx, s);
      case 'upload':
        return resumableUpload(ctx, s);
      case 'poll':
        return poll(ctx, s);
      case 'publish':
        return publish(ctx, s);
      case 'permalink':
        return permalink(ctx, s);
    }
  },
  reconcile,
  classifyError: classifyGeneric,
  async refreshToken({ http, account, tokens, now }) {
    // Token en az 24 saat yaşında olmalı.
    const issued = new Date(account.last_refreshed_at ?? account.created_at).getTime();
    if (now.getTime() - issued < 24 * 3600_000 && account.last_refreshed_at) {
      return {
        ok: false,
        permanent: false,
        message: 'Instagram token 24 saatten genç; yenileme ertelendi',
      };
    }
    const u = new URL(`${IG_GRAPH}/refresh_access_token`);
    u.searchParams.set('grant_type', 'ig_refresh_token');
    u.searchParams.set('access_token', tokens.access_token);
    const res = await http.fetch(
      u.toString(),
      { method: 'GET' },
      { purpose: 'instagram.refresh', platform: 'instagram' },
    );
    const j = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(res);
    if (res.ok && j?.access_token) {
      return {
        ok: true,
        update: {
          tokens: { ...tokens, access_token: j.access_token },
          token_expires_at: expiresAt(now, j.expires_in ?? 60 * 86400),
        },
      };
    }
    const c = classifyIg(res, j);
    return {
      ok: false,
      permanent: c.code === AUTH_EXPIRED || res.status === 400,
      message: c.message,
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
    const tok = (await ctx.tokens()) as AccountTokens;
    for (const id of externalIds) {
      try {
        const r = await graph<{
          data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
        }>(
          ctx.http,
          tok.access_token,
          'GET',
          `${id}/insights`,
          { metric: 'views,reach,likes,comments,shares,saved,total_interactions' },
          'instagram.insights',
        );
        const m = new Map(
          (r.data ?? []).map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? 0]),
        );
        out.set(id, {
          views: m.get('views') ?? 0,
          likes: m.get('likes') ?? 0,
          comments: m.get('comments') ?? 0,
          shares: m.get('shares') ?? 0,
          saves: m.get('saved') ?? 0,
          raw: r.data ?? [],
        });
      } catch (e) {
        ctx.log.warn('instagram.insights_failed', { media_id: id, err: String(e) });
      }
    }
    return out;
  },
};
