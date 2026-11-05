import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatTr, PLATFORM_LABELS, type HealthDTO, type HealthLevel } from '@socialplan/shared';
import { api } from '../lib/api';
import { ErrorState, Skeleton } from '../components/States';
import { PlatformIcon } from '../components/PlatformIcon';
import { Badge } from '../components/ui';

export const LEVEL: Record<
  HealthLevel,
  { label: string; dot: string; tone: 'green' | 'amber' | 'red' }
> = {
  ok: { label: 'Sağlıklı', dot: 'bg-emerald-500', tone: 'green' },
  warn: { label: 'Uyarı', dot: 'bg-amber-400', tone: 'amber' },
  error: { label: 'Sorun', dot: 'bg-red-500', tone: 'red' },
};

export const useHealth = () =>
  useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<HealthDTO>('/health'),
    refetchInterval: 60_000,
    retry: false,
  });

export function HealthDot() {
  const h = useHealth();
  if (!h.data) return null;
  const l = LEVEL[h.data.level];
  return (
    <Link
      to="/saglik"
      title={`Sistem: ${l.label}`}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
    >
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${l.dot}`} />
      <span className="hidden md:inline">{l.label}</span>
    </Link>
  );
}

export function HealthPage() {
  const h = useHealth();
  if (h.isLoading) return <Skeleton rows={8} className="p-6" />;
  if (h.error || !h.data)
    return (
      <div className="p-6">
        <ErrorState error={h.error} onRetry={() => void h.refetch()} />
      </div>
    );
  const d = h.data;
  const c = d.counts;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Sistem sağlığı</h1>
        <Badge tone={LEVEL[d.level].tone}>{LEVEL[d.level].label}</Badge>
        <span className="ml-auto text-xs text-slate-500">
          Güncelleme: {formatTr(d.now)} · her dakika yenilenir
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ['İşleniyor', c.processing],
          ['Yeniden deneniyor', c.retrying],
          ['İşlem gerekli', c.needs_action],
          ['TikTok taslağı bekliyor', c.inbox_waiting],
        ].map(([k, n]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs text-slate-500">{k}</p>
            <p className="text-2xl font-semibold tabular-nums">{n}</p>
          </div>
        ))}
      </div>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
        {d.checks.map((ch) => (
          <li key={ch.key} className="flex items-start gap-3 px-4 py-3 text-sm">
            <span
              className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${LEVEL[ch.level].dot}`}
              aria-label={LEVEL[ch.level].label}
            />
            <span className="w-44 shrink-0 font-medium">{ch.label}</span>
            <span className="text-slate-600">{ch.detail}</span>
          </li>
        ))}
      </ul>
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-semibold">Hesap token'ları</h2>
        {d.tokens.length === 0 ? (
          <p className="text-sm text-slate-500">Bağlı hesap yok.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {d.tokens.map((t) => (
                <tr key={t.account_id}>
                  <td className="py-1.5">
                    <span className="flex items-center gap-2">
                      <PlatformIcon platform={t.platform} size={16} /> {PLATFORM_LABELS[t.platform]}
                    </span>
                  </td>
                  <td className="py-1.5">@{t.username ?? '—'}</td>
                  <td className="py-1.5">
                    {t.status === 'active' ? (
                      <Badge tone="green">Aktif</Badge>
                    ) : (
                      <Badge tone="red">Yeniden bağlanmalı</Badge>
                    )}
                  </td>
                  <td className="py-1.5 text-right text-slate-500">
                    {t.token_expires_at ? `bitiş ${formatTr(t.token_expires_at)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-xs text-slate-500">
        Son cron: {d.last_cron_at ? formatTr(d.last_cron_at) : '—'} · Son günlük işler:{' '}
        {d.last_daily_at ? formatTr(d.last_daily_at) : '—'}. Ayrıntılı log:{' '}
        <code>npx wrangler tail</code>.
      </p>
    </div>
  );
}
