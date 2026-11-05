/**
 * Yayın orkestratörü: bir Queue mesajı = bir adım.
 * Kilit → ön denetimler → publisher.step / reconcile → sonucu koşullu UPDATE ile yaz → gerekiyorsa
 * sonraki adımı delaySeconds'lı mesajla kuyruğa at. Tüm yazımlar `status='processing' AND lease_owner=?`
 * koşulludur: iptal edilen veya lease'i devredilen post'a yazılmaz.
 */
import {
  assertTransition,
  backoffSeconds,
  buildCaption,
  MAX_ATTEMPTS,
  PLATFORM_LABELS,
  type ErrorClass,
  type PostStatus,
} from '@socialplan/shared';
import { isAccountAllowed, isDryRun, type Env, type PublishMessage } from '../env';
import { first, nowIso, parseJson } from '../lib/db';
import { createLogger, type Logger } from '../lib/log';
import { continueLease, eventStmt, leaseUntil, syncVideoStatusStmt } from '../lib/posts';
import { getQuota, useQuota } from '../lib/quota';
import type { AccountRow, BrandRow, PostRow, VideoRow } from '../lib/rows';
import { getSettings, isKillSwitchOn, type Settings } from '../lib/settings';
import { markReconnect, readTokens, saveTokens, type AccountTokens } from '../lib/tokens';
import { notify } from '../notify';
import { createHttp, type HttpClient } from './http';
import { platformPublisher, publisherFor } from './registry';
import {
  AUTH_EXPIRED,
  KillSwitchError,
  type BaseState,
  type PublishContext,
  type Publisher,
  type StepResult,
} from './types';

/** Queue delaySeconds üst sınırı (güvenli taraf: 12 sa). */
const MAX_DELAY_SEC = 12 * 3600;

export function guardedHttp(env: Env, log: Logger): HttpClient {
  const inner = createHttp(env, log);
  return {
    async fetch(url, init, meta) {
      if (await isKillSwitchOn(env.DB)) throw new KillSwitchError();
      return inner.fetch(url, init, meta);
    },
  };
}

export async function enqueue(env: Env, msg: PublishMessage, delaySeconds = 0): Promise<void> {
  const d = Math.max(0, Math.min(MAX_DELAY_SEC, Math.round(delaySeconds)));
  await env.PUBLISH_QUEUE.send(msg, d > 0 ? { delaySeconds: d } : undefined);
}

type Outcome = { status: PostStatus; result: StepResult };

/** Hesap token'ını yenile; başarısızsa hesabı 'reconnect' yapar. */
/** Yenileme kilidi süresi; başarısız denemeden sonra aynı hesabı bu kadar süre zorlamayız. */
/** Platform isteği + kayıt süresinden uzun tutulur (yenilenen refresh token kaybolmasın). */
const REFRESH_LOCK_SEC = 300;
const REFRESH_BACKOFF_SEC = 10 * 60;

/**
 * Hesap token'ını yenile. Eşzamanlı iki yenileme (cron + 401 sonrası) yarışmasın diye hesap başına kilit:
 * kilidi alamayan `busy` döner. Kilit alındıktan sonra kayıt yeniden okunur; başkası az önce yenilediyse
 * (secret_blob değişmiş) platforma gitmeden yeni token kullanılır. Kalıcı hata → hesap 'reconnect'.
 */
export async function refreshAccount(
  env: Env,
  http: HttpClient,
  log: Logger,
  account: AccountRow,
  pub: Publisher,
  now: Date,
): Promise<{ ok: boolean; busy?: boolean; message?: string; tokens?: AccountTokens }> {
  const lock = await env.DB.prepare(
    'UPDATE accounts SET refresh_lock_until = ? WHERE id = ? AND (refresh_lock_until IS NULL OR refresh_lock_until < ?) RETURNING id',
  )
    .bind(
      new Date(now.getTime() + REFRESH_LOCK_SEC * 1000).toISOString(),
      account.id,
      now.toISOString(),
    )
    .first();
  if (!lock)
    return {
      ok: false,
      busy: true,
      message: 'Token yenilemesi sürüyor veya yakın zamanda başarısız oldu',
    };
  let release: string | null = null;
  try {
    const fresh =
      (await env.DB.prepare('SELECT * FROM accounts WHERE id = ?')
        .bind(account.id)
        .first<AccountRow>()) ?? account;
    let tokens: AccountTokens;
    try {
      tokens = await readTokens(env, fresh);
    } catch (e) {
      await markReconnect(env, account.id, 'Token kaydı okunamadı');
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (fresh.secret_blob !== account.secret_blob) {
      log.info('token.refreshed_elsewhere');
      return { ok: true, tokens };
    }
    const r = await pub.refreshToken({ env, http, log, now, account: fresh, tokens });
    if (r.ok) {
      // Platform yeni (dönüşümlü) refresh token verdi: kaydetmek kritik → kısa yeniden deneme.
      let saved = false;
      for (let i = 0; i < 3 && !saved; i++) {
        try {
          await saveTokens(env, account.id, r.update, now);
          saved = true;
        } catch (e) {
          log.warn('token.save_failed', {
            attempt: i + 1,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!saved) {
        await notify(
          env,
          {
            kind: 'token_lost',
            dedupeKey: `token_save_failed:${account.id}:${now.toISOString().slice(0, 13)}`,
            title: `${PLATFORM_LABELS[account.platform]} token kaydedilemedi`,
            text: `@${account.username ?? account.external_id}: yenilenen token veritabanına yazılamadı; hesabı yeniden bağlamanız gerekebilir.`,
          },
          log,
        );
        return { ok: false, message: 'Yenilenen token kaydedilemedi' };
      }
      return { ok: true, tokens: r.update.tokens };
    }
    release = new Date(now.getTime() + REFRESH_BACKOFF_SEC * 1000).toISOString();
    if (r.permanent) {
      await markReconnect(env, account.id, r.message);
      await notify(
        env,
        {
          kind: 'token_lost',
          dedupeKey: `token_lost:${account.id}:${now.toISOString().slice(0, 10)}`,
          title: `${PLATFORM_LABELS[account.platform]} bağlantısı düştü`,
          text: `@${account.username ?? account.external_id}: ${r.message}. Hesaplar ekranından yeniden bağlayın.`,
        },
        log,
      );
    }
    return { ok: false, message: r.message };
  } finally {
    await env.DB.prepare('UPDATE accounts SET refresh_lock_until = ? WHERE id = ?')
      .bind(release, account.id)
      .run();
  }
}

export async function processMessage(
  env: Env,
  msgIn: PublishMessage,
  now: Date = new Date(),
): Promise<Outcome | null> {
  let msg = msgIn;
  const log = createLogger({ trace_id: msg.traceId, post_id: msg.postId });
  const db = env.DB;
  const seq = await continueLease(db, msg.postId, msg.leaseOwner, msg.seq, now);
  if (seq === null) {
    log.info('lease.not_acquired', { seq: msg.seq });
    return null;
  }
  msg = { ...msg, seq };
  const post = await first<PostRow>(db, 'SELECT * FROM posts WHERE id = ?', msg.postId);
  if (!post) return null;
  const plog = log.child({ platform: post.platform, attempt: post.attempt_count });

  const [video, account, brand, settings] = await Promise.all([
    first<VideoRow>(db, 'SELECT * FROM videos WHERE id = ?', post.video_id),
    first<AccountRow>(db, 'SELECT * FROM accounts WHERE id = ?', post.account_id),
    first<BrandRow>(db, 'SELECT * FROM brands WHERE id = ?', post.brand_id),
    getSettings(db),
  ]);

  const http = guardedHttp(env, plog);
  const pub = publisherFor(env, post.platform);
  let state = parseJson<BaseState>(post.platform_state, { step: '' });
  if (!state.step && pub) state = pub.initialState();

  const apply = (result: StepResult): Promise<Outcome> =>
    applyResult(env, post, msg, state, result, now, plog);

  // --- Ön denetimler ---
  if (!video || !account || !brand || video.deleted_at) {
    return apply({
      kind: 'error',
      class: 'permanent',
      code: 'missing_entity',
      message: 'Video, hesap veya marka bulunamadı',
    });
  }
  if (settings.kill_switch) {
    return apply({
      kind: 'error',
      class: 'action',
      code: 'kill_switch',
      message: 'Kill switch açık: paylaşım durduruldu',
    });
  }
  if (brand.paused && !post.step) {
    // Henüz başlamamış iş: kuyruğa geri bırak; marka açılınca cron tekrar alır.
    assertTransition('processing', 'scheduled', 'system');
    await db.batch([
      db
        .prepare(
          "UPDATE posts SET status = 'scheduled', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?",
        )
        .bind(nowIso(now), post.id, msg.leaseOwner),
      eventStmt(db, post, 'processing', 'scheduled', null, { reason: 'brand_paused' }, now),
    ]);
    return { status: 'scheduled', result: { kind: 'continue', state } };
  }
  if (!pub)
    return apply({
      kind: 'error',
      class: 'permanent',
      code: 'no_publisher',
      message: `${post.platform} için publisher yok`,
    });
  const dry = isDryRun(env);
  if (!dry) {
    if (account.status !== 'active') {
      return apply({
        kind: 'error',
        class: 'action',
        code: 'account_reconnect',
        message: 'Hesabın yeniden bağlanması gerekiyor',
      });
    }
    if (!isAccountAllowed(env, account)) {
      return apply({
        kind: 'error',
        class: 'action',
        code: 'account_not_allowed',
        message: 'Hesap ALLOWED_ACCOUNT_IDS beyaz listesinde değil',
      });
    }
  }
  const validation = parseJson<Record<
    string,
    { ok: boolean; issues: { message: string }[] }
  > | null>(video.validation, null);
  const pv = validation?.[post.platform];
  if (pv && !pv.ok) {
    return apply({
      kind: 'error',
      class: 'permanent',
      code: 'video_invalid',
      message: pv.issues.map((i) => i.message).join('; '),
    });
  }
  const extra = pub.validate(video, account);
  if (extra.length)
    return apply({
      kind: 'error',
      class: 'permanent',
      code: 'video_invalid',
      message: extra.join('; '),
    });

  // --- Bağlam ---
  let tokenCache: AccountTokens | null = null;
  let committedState: BaseState | null = null;
  const caption =
    post.caption_snapshot ??
    buildCaption(
      {
        title: video.title,
        description: video.description,
        hashtags: parseJson(video.hashtags, []),
        caption_overrides: parseJson(video.caption_overrides, {}),
      },
      post.platform,
      { signature: brand.caption_signature },
    );
  const ctx: PublishContext = {
    env,
    http,
    log: plog,
    now,
    post,
    video,
    account,
    brand,
    settings: settings satisfies Settings,
    caption,
    tokens: async () => (tokenCache ??= await readTokens(env, account)),
    beginCommit: async (s) => {
      committedState = { ...s, commitPending: true };
      const r = await db
        .prepare(
          "UPDATE posts SET commit_started_at = ?, platform_state = ?, step = ?, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?",
        )
        .bind(
          nowIso(now),
          JSON.stringify(committedState),
          committedState.step,
          nowIso(now),
          post.id,
          msg.leaseOwner,
        )
        .run();
      if (r.meta.changes !== 1) throw new Error('Lease kaybedildi: commit başlatılmadı');
    },
    quota: {
      use: (p, k, d, b, a, l) => useQuota(db, p, k, d, b, a, l),
      get: (p, k, d, b) => getQuota(db, p, k, d, b),
    },
  };

  // --- Adım (istisnalar sonuca çevrilir; 401 → bir kez yenile + tekrar) ---
  const run = async (): Promise<StepResult> => {
    try {
      return await (state.commitPending ? pub.reconcile(ctx, state) : pub.step(ctx, state));
    } catch (e) {
      if (e instanceof KillSwitchError)
        return { kind: 'error', class: 'action', code: 'kill_switch', message: e.message };
      return { kind: 'error', ...pub.classifyError(e) };
    }
  };
  let result = await run();
  if (result.kind === 'error' && result.code === AUTH_EXPIRED && !dry) {
    const realPub = platformPublisher(post.platform);
    const ref = realPub
      ? await refreshAccount(env, http, plog, account, realPub, now)
      : { ok: false, message: 'publisher yok' };
    if (ref.ok && ref.tokens) {
      tokenCache = ref.tokens;
      if (committedState) state = committedState;
      result = await run();
      if (result.kind === 'error' && result.code === AUTH_EXPIRED) {
        await markReconnect(env, account.id, 'Yenilenen token da reddedildi');
        result = {
          kind: 'error',
          class: 'action',
          code: 'token_invalid',
          message: 'Token yenilendi ama platform yine reddetti; hesabı yeniden bağlayın',
        };
      }
    } else if ('busy' in ref && ref.busy) {
      result = {
        kind: 'error',
        class: 'transient',
        code: 'token_refresh_busy',
        message: ref.message ?? 'Token yenilemesi sürüyor',
        retryAfterSec: 60,
      };
    } else {
      result = {
        kind: 'error',
        class: 'action',
        code: 'token_refresh_failed',
        message: `Token yenilenemedi: ${ref.message ?? ''}`,
      };
    }
  }
  if (result.kind === 'error' && !result.state && committedState)
    result = { ...result, state: committedState };
  return apply(result);
}

async function applyResult(
  env: Env,
  post: PostRow,
  msg: PublishMessage,
  prev: BaseState,
  result: StepResult,
  now: Date,
  log: Logger,
): Promise<Outcome> {
  const db = env.DB;
  const n = nowIso(now);
  const cond = "WHERE id = ? AND status = 'processing' AND lease_owner = ?";
  const finish = async (
    to: PostStatus,
    set: Record<string, string | number | null>,
    detail: Record<string, unknown>,
  ): Promise<boolean> => {
    assertTransition('processing', to, 'system');
    const all: Record<string, string | number | null> = {
      ...set,
      status: to,
      lease_owner: null,
      lease_until: null,
      updated_at: n,
    };
    const cols = Object.keys(all);
    const [r] = await db.batch([
      db
        .prepare(`UPDATE posts SET ${cols.map((c) => `${c} = ?`).join(', ')} ${cond}`)
        .bind(...cols.map((c) => all[c] ?? null), post.id, msg.leaseOwner),
      eventStmt(
        db,
        post,
        'processing',
        to,
        (set.step as string | undefined) ?? post.step,
        detail,
        now,
      ),
      syncVideoStatusStmt(db, post.video_id, now),
    ]);
    const ok = (r?.meta.changes ?? 0) === 1;
    if (!ok) log.warn('result.lost_lease', { to });
    return ok;
  };

  switch (result.kind) {
    case 'continue': {
      const wait = result.waitSeconds ?? 0;
      const s = result.state;
      const r = await db
        .prepare(
          `UPDATE posts SET platform_state = ?, step = ?, lease_until = ?, commit_started_at = ${s.commitPending ? 'commit_started_at' : 'NULL'}, updated_at = ? ${cond}`,
        )
        .bind(JSON.stringify(s), s.step, leaseUntil(now, wait), n, post.id, msg.leaseOwner)
        .run();
      if (r.meta.changes !== 1) return { status: 'processing', result };
      if (s.step !== prev.step)
        await eventStmt(db, post, 'processing', 'processing', s.step, { wait }, now).run();
      await enqueue(env, msg, wait);
      log.info('step.continue', { step: s.step, wait });
      return { status: 'processing', result };
    }
    case 'done': {
      await finish(
        'published',
        {
          step: 'done',
          platform_state: JSON.stringify({ ...(result.state ?? prev), commitPending: false }),
          external_id: result.externalId,
          external_url: result.url,
          visibility: result.visibility ?? null,
          published_at: n,
          commit_started_at: null,
          error_class: null,
          last_error_code: null,
          last_error_message: null,
        },
        { external_id: result.externalId, url: result.url, visibility: result.visibility ?? null },
      );
      log.info('post.published', { external_id: result.externalId });
      return { status: 'published', result };
    }
    case 'inbox': {
      const ok = await finish(
        'inbox_sent',
        {
          step: 'inbox',
          platform_state: JSON.stringify({ ...result.state, commitPending: false }),
          external_id: result.externalId ?? null,
          commit_started_at: null,
          error_class: null,
          last_error_code: null,
          last_error_message: null,
        },
        { publish_id: result.externalId ?? null },
      );
      if (ok) {
        const account = await first<AccountRow>(
          db,
          'SELECT username, external_id FROM accounts WHERE id = ?',
          post.account_id,
        );
        await notify(
          env,
          {
            kind: 'tiktok_inbox',
            dedupeKey: `tiktok_inbox:${post.id}`,
            title: "TikTok'ta yayınla",
            text: `@${account?.username ?? account?.external_id ?? '?'} hesabının TikTok gelen kutusuna taslak gönderildi. Uygulamadan yayınlayıp panelde "Yayınladım" işaretleyin.${post.caption_snapshot ? `\nMetin: ${post.caption_snapshot.slice(0, 300)}` : ''}`,
            url: `${env.APP_BASE_URL}/planlama?post=${post.id}`,
          },
          log,
        );
      }
      return { status: 'inbox_sent', result };
    }
    case 'error': {
      const state = result.state ?? prev;
      const base = {
        platform_state: JSON.stringify(state),
        step: state.step || post.step,
        error_class: result.class as ErrorClass,
        last_error_code: result.code,
        last_error_message: result.message.slice(0, 1000),
      };
      if (result.class === 'transient') {
        const failures = post.attempt_count + 1;
        if (failures <= MAX_ATTEMPTS) {
          const wait = backoffSeconds(failures, result.retryAfterSec);
          const r = await db
            .prepare(
              `UPDATE posts SET platform_state = ?, step = ?, error_class = ?, last_error_code = ?, last_error_message = ?, attempt_count = ?, next_attempt_at = ?, lease_until = ?, updated_at = ? ${cond}`,
            )
            .bind(
              base.platform_state,
              base.step,
              base.error_class,
              base.last_error_code,
              base.last_error_message,
              failures,
              new Date(now.getTime() + wait * 1000).toISOString(),
              leaseUntil(now, wait),
              n,
              post.id,
              msg.leaseOwner,
            )
            .run();
          if (r.meta.changes === 1) {
            await eventStmt(
              db,
              post,
              'processing',
              'processing',
              base.step,
              {
                retry_in_sec: wait,
                error_code: result.code,
                message: result.message,
                attempt: failures,
              },
              now,
            ).run();
            await enqueue(env, msg, wait);
          }
          log.warn('step.retry', { error_code: result.code, wait, attempt: failures });
          return { status: 'processing', result };
        }
      }
      const to: PostStatus = result.class === 'action' ? 'needs_action' : 'failed';
      const ok = await finish(
        to,
        {
          ...base,
          attempt_count: result.class === 'transient' ? post.attempt_count + 1 : post.attempt_count,
        },
        { error_class: result.class, error_code: result.code, message: result.message },
      );
      if (ok) {
        await notify(
          env,
          {
            kind: to === 'failed' ? 'publish_failed' : 'needs_action',
            dedupeKey: `${to}:${post.id}:${post.updated_at}`,
            title: `${PLATFORM_LABELS[post.platform]}: ${to === 'failed' ? 'yayın hatası' : 'işlem gerekli'}`,
            text: `${result.message} (${result.code})`,
            url: `${env.APP_BASE_URL}/planlama?post=${post.id}`,
          },
          log,
        );
      }
      log.warn('post.' + to, { error_code: result.code });
      return { status: to, result };
    }
  }
}
