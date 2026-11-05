import type { Platform } from '@socialplan/shared';
import { isDryRun, type Env } from '../env';
import { dryRunPublisher } from './dryrun';
import type { Publisher } from './types';

const registry = new Map<Platform, Publisher>();

export function registerPublisher(p: Publisher): void {
  if (p.name !== 'dryrun') registry.set(p.name, p);
}

/** Testler: bir platformun publisher'ını geçici olarak değiştir; geri yükleme fonksiyonu döner. */
export function overridePublisherForTesting(platform: Platform, p: Publisher): () => void {
  const prev = registry.get(platform);
  registry.set(platform, p);
  return () => {
    if (prev) registry.set(platform, prev);
    else registry.delete(platform);
  };
}

export function platformPublisher(platform: Platform): Publisher | null {
  return registry.get(platform) ?? null;
}

export function publisherFor(env: Env, platform: Platform): Publisher | null {
  if (isDryRun(env)) return dryRunPublisher as unknown as Publisher;
  return platformPublisher(platform);
}
