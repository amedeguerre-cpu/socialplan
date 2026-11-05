/**
 * DRY_RUN publisher: hiçbir dış istek atmadan gerçekçi ara adımlar üretir.
 * Instagram/YouTube → "yayınlandı (dry-run)"; TikTok → gerçek akıştaki gibi "taslağa gönderildi".
 */
import type { BaseState, Publisher } from './types';

interface DryState extends BaseState {
  step: 'prepare' | 'upload' | 'processing' | 'commit';
  chunk?: number;
  totalChunks?: number;
}

export const dryRunPublisher: Publisher<DryState> = {
  name: 'dryrun',
  refreshLeadSeconds: 0,
  validate: () => [],
  initialState: () => ({ step: 'prepare' }),
  async step(ctx, s) {
    switch (s.step) {
      case 'prepare': {
        const total = Math.max(1, Math.min(4, Math.ceil(ctx.video.size_bytes / (8 * 1024 * 1024))));
        return {
          kind: 'continue',
          state: { step: 'upload', chunk: 0, totalChunks: total },
          waitSeconds: 0,
        };
      }
      case 'upload': {
        const next = (s.chunk ?? 0) + 1;
        if (next < (s.totalChunks ?? 1))
          return { kind: 'continue', state: { ...s, chunk: next }, waitSeconds: 0 };
        return {
          kind: 'continue',
          state: { step: 'processing', chunk: next, totalChunks: s.totalChunks },
          waitSeconds: 2,
        };
      }
      case 'processing':
        return { kind: 'continue', state: { ...s, step: 'commit' }, waitSeconds: 1 };
      case 'commit': {
        await ctx.beginCommit({ ...s, commitPending: true });
        const externalId = `dry-${ctx.post.platform}-${ctx.post.id.slice(0, 8)}`;
        if (ctx.post.platform === 'tiktok')
          return { kind: 'inbox', state: { ...s, commitPending: false }, externalId };
        return {
          kind: 'done',
          externalId,
          url: `https://dry-run.invalid/${ctx.post.platform}/${externalId}`,
          visibility: 'dry-run',
          state: { ...s, commitPending: false },
        };
      }
    }
  },
  async reconcile(ctx, s) {
    // Dry-run'da commit her zaman başarılı sayılır.
    const externalId = `dry-${ctx.post.platform}-${ctx.post.id.slice(0, 8)}`;
    if (ctx.post.platform === 'tiktok')
      return { kind: 'inbox', state: { ...s, commitPending: false }, externalId };
    return {
      kind: 'done',
      externalId,
      url: `https://dry-run.invalid/${ctx.post.platform}/${externalId}`,
      visibility: 'dry-run',
    };
  },
  classifyError: (e) => ({
    class: 'transient',
    code: 'dry_run_error',
    message: e instanceof Error ? e.message : String(e),
  }),
  refreshToken: async () => ({ ok: false, permanent: false, message: 'dry-run' }),
  fetchMetrics: async () => new Map(),
};
