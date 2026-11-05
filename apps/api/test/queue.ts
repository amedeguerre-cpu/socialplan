import type { Env, PublishMessage } from '../src/env';
import { processMessage } from '../src/publish/orchestrator';
import { testEnv } from './helpers';

export interface Sent {
  body: PublishMessage;
  delay: number;
}

export function fakeQueue(): { queue: Queue<PublishMessage>; sent: Sent[] } {
  const sent: Sent[] = [];
  const queue = {
    async send(body: PublishMessage, opts?: QueueSendOptions) {
      sent.push({ body, delay: opts?.delaySeconds ?? 0 });
    },
    async sendBatch(msgs: Iterable<MessageSendRequest<PublishMessage>>) {
      for (const m of msgs) sent.push({ body: m.body, delay: m.delaySeconds ?? 0 });
    },
    async metrics() {
      return { backlogCount: 0, backlogBytes: 0 };
    },
  } as unknown as Queue<PublishMessage>;
  return { queue, sent };
}

/** Kuyruğu sanal saatle boşalt: her mesaj, gecikmesi kadar ileri alınmış zamanda işlenir. */
export async function drain(env: Env, sent: Sent[], start: Date, maxSteps = 200): Promise<Date> {
  let now = start;
  let steps = 0;
  while (sent.length && steps++ < maxSteps) {
    sent.sort((a, b) => a.delay - b.delay);
    const m = sent.shift() as Sent;
    now = new Date(now.getTime() + m.delay * 1000);
    for (const s of sent) s.delay = Math.max(0, s.delay - m.delay);
    await processMessage(env, m.body, now);
  }
  return now;
}

export function queueEnv(over: Partial<Env> = {}): { env: Env; sent: Sent[] } {
  const q = fakeQueue();
  return { env: testEnv({ PUBLISH_QUEUE: q.queue, ...over }), sent: q.sent };
}
