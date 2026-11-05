/**
 * Ölü mektup kuyruğu tüketicisi: max_retries sonrası düşen mesajın post'u hâlâ aynı sahipte işleniyorsa
 * "işlem gerekli" yapılır (commit_started_at korunur → "Tekrar dene" reconcile eder) ve bildirim gider.
 */
import { assertTransition, PLATFORM_LABELS } from '@socialplan/shared';
import type { Env, PublishMessage } from '../env';
import { first, nowIso } from '../lib/db';
import type { Logger } from '../lib/log';
import { eventStmt } from '../lib/posts';
import type { PostRow } from '../lib/rows';
import { notify } from '../notify';

export async function handleDeadLetter(
  env: Env,
  msg: PublishMessage,
  attempts: number,
  log: Logger,
  now = new Date(),
): Promise<boolean> {
  const post = await first<PostRow>(env.DB, 'SELECT * FROM posts WHERE id = ?', msg.postId);
  if (!post || post.status !== 'processing' || post.lease_owner !== msg.leaseOwner) {
    log.info('dlq.ignored', { post_id: msg.postId, status: post?.status });
    return false;
  }
  assertTransition('processing', 'needs_action', 'system');
  const [r] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE posts SET status = 'needs_action', error_class = 'action', last_error_code = 'dlq', last_error_message = ?, lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'processing' AND lease_owner = ?",
    ).bind(
      `Kuyruk mesajı ${attempts} denemeden sonra işlenemedi (beklenmeyen hata)`,
      nowIso(now),
      post.id,
      msg.leaseOwner,
    ),
    eventStmt(
      env.DB,
      post,
      'processing',
      'needs_action',
      'dlq',
      { attempts, step: post.step },
      now,
    ),
  ]);
  if ((r?.meta.changes ?? 0) !== 1) return false;
  await notify(
    env,
    {
      kind: 'dlq',
      dedupeKey: `dlq:${post.id}:${msg.seq}`,
      title: `${PLATFORM_LABELS[post.platform]}: işlenemeyen paylaşım`,
      text: 'Kuyruk mesajı tekrar tekrar beklenmeyen hata verdi; paylaşım "İşlem gerekli" yapıldı. Logları (wrangler tail) inceleyip "Tekrar dene".',
      url: `${env.APP_BASE_URL}/planlama?post=${post.id}`,
    },
    log,
  );
  return true;
}
