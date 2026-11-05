import type { Platform } from '@socialplan/shared';
import type { OAuthAdapter } from './types';

const adapters = new Map<Platform, OAuthAdapter>();
export function registerOAuth(a: OAuthAdapter): void {
  adapters.set(a.platform, a);
}
export function oauthAdapter(p: Platform): OAuthAdapter | null {
  return adapters.get(p) ?? null;
}
