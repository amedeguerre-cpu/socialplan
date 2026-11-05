import type { Env, PublishMessage } from '../env';

export async function handleQueue(batch: MessageBatch<PublishMessage>, _env: Env): Promise<void> {
  // Faz 2'de doldurulur.
  batch.ackAll();
}
