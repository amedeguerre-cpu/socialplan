import type { Env, PublishMessage } from '../env';
import { createLogger } from '../lib/log';
import { handleDeadLetter } from './deadletter';
import { processMessage } from './orchestrator';
import './publishers';

export async function handleQueue(batch: MessageBatch<PublishMessage>, env: Env): Promise<void> {
  const log = createLogger({ queue: batch.queue });
  if (batch.queue.endsWith('-dlq')) {
    for (const msg of batch.messages) {
      try {
        await handleDeadLetter(env, msg.body, msg.attempts, log);
      } catch (e) {
        log.error('dlq.failed', {
          post_id: msg.body.postId,
          err: e instanceof Error ? e.message : String(e),
        });
      }
      msg.ack();
    }
    return;
  }
  for (const msg of batch.messages) {
    try {
      await processMessage(env, msg.body);
      msg.ack();
    } catch (e) {
      // Beklenmeyen hata (D1 vb.): mesajı geri çekilmeyle tekrar dene; max_retries sonrası DLQ.
      log.error('queue.unhandled', {
        post_id: msg.body.postId,
        trace_id: msg.body.traceId,
        err: e instanceof Error ? e.message : String(e),
        attempts: msg.attempts,
      });
      msg.retry({ delaySeconds: Math.min(600, 30 * 2 ** Math.min(msg.attempts, 5)) });
    }
  }
}
