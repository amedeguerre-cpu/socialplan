/**
 * Publisher sözleşmesi. Publisher'lar orkestratörden bağımsız adım fonksiyonlarıdır:
 * her çağrı tek bir idempotent adım yürütür, ara durumu `state` ile döndürür; orkestratör durumu D1'e
 * yazar ve sonraki adımı `waitSeconds` gecikmeli yeni Queue mesajıyla tetikler (Worker'da sleep yok).
 */
import type { ErrorClass, Platform } from '@socialplan/shared';
import type { Env } from '../env';
import type { Logger } from '../lib/log';
import type { AccountRow, BrandRow, PostRow, VideoRow } from '../lib/rows';
import type { Settings } from '../lib/settings';
import type { AccountTokens, TokenUpdate } from '../lib/tokens';
import type { HttpClient } from './http';

export interface BaseState {
  step: string;
  /** Geri dönüşsüz çağrı başladı ama sonucu henüz kesinleşmedi. */
  commitPending?: boolean;
  [k: string]: unknown;
}

export type StepResult<S extends BaseState = BaseState> =
  | { kind: 'continue'; state: S; waitSeconds?: number }
  | { kind: 'done'; externalId: string; url: string | null; visibility?: string | null; state?: S }
  | { kind: 'inbox'; state: S; externalId?: string | null }
  | {
      kind: 'error';
      class: ErrorClass;
      code: string;
      message: string;
      retryAfterSec?: number;
      state?: S;
    };

export interface PublishContext {
  env: Env;
  /** Kill switch denetimli tek HTTP istemcisi. */
  http: HttpClient;
  log: Logger;
  now: Date;
  post: PostRow;
  video: VideoRow;
  account: AccountRow;
  brand: BrandRow;
  settings: Settings;
  caption: string;
  tokens(): Promise<AccountTokens>;
  /** Geri dönüşsüz çağrıdan hemen önce: commit_started_at + state (commitPending=true) yazılır. */
  beginCommit(state: BaseState): Promise<void>;
  /** Kota defteri. */
  quota: {
    use(
      platform: Platform,
      scopeKey: string,
      day: string,
      bucket: string,
      amount: number,
      limit: number,
    ): Promise<boolean>;
    get(platform: Platform, scopeKey: string, day: string, bucket: string): Promise<number>;
  };
}

export interface MetricsResult {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  raw: unknown;
}

export interface RefreshContext {
  env: Env;
  http: HttpClient;
  log: Logger;
  now: Date;
  account: AccountRow;
  tokens: AccountTokens;
}

export type RefreshResult =
  { ok: true; update: TokenUpdate } | { ok: false; permanent: boolean; message: string };

export interface Publisher<S extends BaseState = BaseState> {
  readonly name: Platform | 'dryrun';
  /** Yayın öncesi ek denetim (doğrulama tablosuna ek, hesap bazlı). Hata mesajları döner. */
  validate(video: VideoRow, account: AccountRow): string[];
  initialState(): S;
  step(ctx: PublishContext, state: S): Promise<StepResult<S>>;
  /** commitPending iken devam: platformda durum sorgulanır; belirsizse action. ASLA kör retry. */
  reconcile(ctx: PublishContext, state: S): Promise<StepResult<S>>;
  classifyError(e: unknown): { class: ErrorClass; code: string; message: string };
  /** Token süresi dolmadan yenileme (cron) veya 401 sonrası. */
  refreshToken(rc: RefreshContext): Promise<RefreshResult>;
  /** Yenileme ne kadar önce yapılmalı (sn). */
  refreshLeadSeconds: number;
  fetchMetrics(
    ctx: Omit<PublishContext, 'beginCommit' | 'caption'>,
    externalIds: string[],
  ): Promise<Map<string, MetricsResult>>;
}

/** Publisher'ın 401 vb. için döndürdüğü kod — orkestratör yenileyip adımı bir kez tekrarlar. */
export const AUTH_EXPIRED = 'auth_expired';

export class KillSwitchError extends Error {
  readonly code = 'kill_switch';
  constructor() {
    super('Kill switch açık: dış çağrı yapılmadı');
  }
}
