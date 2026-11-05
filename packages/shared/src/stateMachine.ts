export const POST_STATUSES = [
  'draft',
  'scheduled',
  'processing',
  'inbox_sent',
  'published',
  'needs_action',
  'failed',
  'cancelled',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  draft: 'Taslak',
  scheduled: 'Planlandı',
  processing: 'İşleniyor',
  inbox_sent: 'Taslağa gönderildi',
  published: 'Yayınlandı',
  needs_action: 'İşlem gerekli',
  failed: 'Hata',
  cancelled: 'İptal',
};

export const POST_STATUS_COLORS: Record<PostStatus, string> = {
  draft: '#9ca3af',
  scheduled: '#3b82f6',
  processing: '#f59e0b',
  inbox_sent: '#8b5cf6',
  published: '#10b981',
  needs_action: '#f97316',
  failed: '#ef4444',
  cancelled: '#6b7280',
};

/** Kimin tetiklediği: sistem (cron/queue) veya insan (panel). */
export type Actor = 'system' | 'human';

interface Transition {
  to: PostStatus;
  by: readonly Actor[];
}

const T = (to: PostStatus, ...by: Actor[]): Transition => ({ to, by });

/** Geçişlerin TEK kaynağı. */
export const TRANSITIONS: Record<PostStatus, readonly Transition[]> = {
  draft: [T('scheduled', 'human', 'system'), T('cancelled', 'human')],
  scheduled: [
    T('processing', 'system'),
    T('draft', 'human'),
    T('needs_action', 'system'), // kaçırılan slot, kill switch
    T('cancelled', 'human'),
    T('scheduled', 'human'), // yeniden zamanlama
  ],
  processing: [
    T('processing', 'system'), // adım devamı / lease devralma
    T('published', 'system'),
    T('inbox_sent', 'system'),
    T('needs_action', 'system'),
    T('failed', 'system'),
    T('scheduled', 'system'), // geçici hata sonrası yeniden deneme
    T('cancelled', 'human'),
  ],
  inbox_sent: [
    T('published', 'human', 'system'),
    T('needs_action', 'system'),
    T('cancelled', 'human'),
  ],
  published: [],
  needs_action: [
    T('scheduled', 'human'),
    T('cancelled', 'human'),
    T('published', 'human', 'system'),
  ],
  failed: [T('scheduled', 'human'), T('cancelled', 'human')],
  cancelled: [],
};

export function canTransition(from: PostStatus, to: PostStatus, by: Actor): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.by.includes(by));
}

export class TransitionError extends Error {
  constructor(
    public readonly from: PostStatus,
    public readonly to: PostStatus,
    public readonly by: Actor,
  ) {
    super(`Geçersiz durum geçişi: ${from} → ${to} (${by})`);
  }
}

export function assertTransition(from: PostStatus, to: PostStatus, by: Actor): void {
  if (!canTransition(from, to, by)) throw new TransitionError(from, to, by);
}

export const TERMINAL_STATUSES: readonly PostStatus[] = ['published', 'cancelled'];
export const isTerminal = (s: PostStatus): boolean => TERMINAL_STATUSES.includes(s);

/** Bir insanın iptal edebileceği durumlar. */
export const CANCELLABLE: readonly PostStatus[] = POST_STATUSES.filter((s) =>
  canTransition(s, 'cancelled', 'human'),
);

export type ErrorClass = 'transient' | 'permanent' | 'action';
export const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_SEC = [60, 300, 1500] as const;

/**
 * Geçici hata sonrası bekleme: 1/5/25 dk + %0–20 jitter; Retry-After daha uzunsa ona uyulur.
 * attempt: 1'den başlar (ilk başarısız deneme = 1).
 */
export function backoffSeconds(
  attempt: number,
  retryAfterSec?: number,
  rand: () => number = Math.random,
): number {
  const base =
    BACKOFF_BASE_SEC[Math.min(Math.max(attempt, 1), BACKOFF_BASE_SEC.length) - 1] ?? 1500;
  const jittered = Math.round(base * (1 + 0.2 * rand()));
  return Math.max(jittered, Math.ceil(retryAfterSec ?? 0));
}
