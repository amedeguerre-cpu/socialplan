/** Platform yanıtlarından hata sınıflandırması için ortak yardımcılar. */
import type { ErrorClass } from '@socialplan/shared';
import { DryRunBlockedError, NetworkError, retryAfterSeconds } from './http';
import { AUTH_EXPIRED, KillSwitchError } from './types';

export interface ClassifiedError {
  class: ErrorClass;
  code: string;
  message: string;
  retryAfterSec?: number;
}

export class PlatformHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly classified: ClassifiedError,
  ) {
    super(classified.message);
  }
}

export function classifyGeneric(e: unknown): ClassifiedError {
  if (e instanceof PlatformHttpError) return e.classified;
  if (e instanceof KillSwitchError)
    return { class: 'action', code: 'kill_switch', message: e.message };
  if (e instanceof DryRunBlockedError)
    return { class: 'action', code: 'dry_run_blocked', message: e.message };
  if (e instanceof NetworkError)
    return { class: 'transient', code: 'network_error', message: e.message };
  return {
    class: 'transient',
    code: 'unexpected',
    message: e instanceof Error ? e.message : String(e),
  };
}

/** HTTP durum kodundan varsayılan sınıf (platforma özgü eşlemeden sonra son çare). */
export function classifyStatus(res: Response, message: string, code?: string): ClassifiedError {
  const s = res.status;
  if (s === 401) return { class: 'transient', code: AUTH_EXPIRED, message };
  if (s === 429)
    return {
      class: 'transient',
      code: code ?? 'rate_limited',
      message,
      retryAfterSec: retryAfterSeconds(res) ?? 300,
    };
  if (s >= 500)
    return {
      class: 'transient',
      code: code ?? `http_${s}`,
      message,
      retryAfterSec: retryAfterSeconds(res),
    };
  if (s === 403) return { class: 'action', code: code ?? 'forbidden', message };
  return { class: 'permanent', code: code ?? `http_${s}`, message };
}
