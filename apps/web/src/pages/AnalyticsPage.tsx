import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PLATFORMS, PLATFORM_LABELS, type AnalyticsDTO, type HeatCell } from '@socialplan/shared';
import { api, qs } from '../lib/api';
import { useBrand } from '../lib/brand';
import { useInvalidate, useSettings } from '../lib/hooks';
import { PlatformIcon } from '../components/PlatformIcon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Button, inputCls } from '../components/ui';
import { WEEKDAYS } from './SettingsPage';

// Veri görselleştirme rolleri (dataviz referans paleti, açık mod).
const SERIES_1 = '#2a78d6';
const SERIES_2 = '#eb6834';
const GRID = '#e7e5e0';
const INK_2 = '#52514e';
/** Sıralı tek ton (mavi) açık → koyu. */
const SEQ = [
  '#eaf2fc',
  '#c7dcf6',
  '#9cc1ee',
  '#6aa2e4',
  '#3f84da',
  '#2a78d6',
  '#1d5fae',
  '#164a88',
];

const nf = new Intl.NumberFormat('tr-TR');
const pf = new Intl.NumberFormat('tr-TR', { style: 'percent', maximumFractionDigits: 1 });

export function heatColor(rate: number | null, max: number): string {
  if (rate === null || max <= 0) return '#f6f5f2';
  const i = Math.min(SEQ.length - 1, Math.floor((rate / max) * (SEQ.length - 1) + 0.0001));
  return SEQ[i] as string;
}

export function AnalyticsPage() {
  const { brand, brandId } = useBrand();
  const settings = useSettings();
  const inv = useInvalidate();
  const [allBrands, setAllBrands] = useState(false);
  const [platform, setPlatform] = useState('');
  const [days, setDays] = useState(30);
  const params = qs({ brand_id: allBrands ? undefined : brandId, platform, days });
  const q = useQuery({
    queryKey: ['analytics', params],
    queryFn: () => api.get<AnalyticsDTO>(`/analytics${params}`),
    enabled: allBrands || !!brandId,
  });
  const [msg, setMsg] = useState<string | null>(null);

  const demo = async () => {
    try {
      const r = await api.post<{ created: number }>('/analytics/demo', {
        brand_id: brandId,
        posts: 150,
      });
      setMsg(`${r.created} demo paylaşım üretildi`);
      await inv(['analytics']);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Üretilemedi');
    }
  };

  const a = q.data;
  const eng = a ? a.totals.likes + a.totals.comments + a.totals.shares + a.totals.saves : 0;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={allBrands}
            onChange={(e) => setAllBrands(e.target.checked)}
          />{' '}
          Tüm markalar
        </label>
        {!allBrands && <span className="text-slate-500">{brand?.name}</span>}
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className={`${inputCls} w-40!`}
          aria-label="Platform"
        >
          <option value="">Tüm platformlar</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
        <div
          className="flex rounded-md border border-slate-300 bg-white p-0.5"
          role="group"
          aria-label="Dönem"
        >
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded px-2.5 py-1 ${days === d ? 'bg-brand-600 text-white' : 'text-slate-600'}`}
            >
              {d} gün
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {settings.data?.dry_run && brandId && (
          <Button
            onClick={() => void demo()}
            title="Yalnız DRY_RUN: sahte geçmiş paylaşım ve metrik üretir"
          >
            Demo veri üret
          </Button>
        )}
        {msg && <span className="text-slate-600">{msg}</span>}
      </div>

      {q.isLoading ? (
        <Skeleton rows={8} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !a || a.totals.posts === 0 ? (
        <EmptyState title="Bu dönemde metrik yok">
          Metrikler her gün İstanbul 04:10'da yayınlanmış paylaşımlar için çekilir.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Görüntülenme" value={nf.format(a.totals.views)} />
            <Stat
              label="Etkileşim"
              value={nf.format(eng)}
              hint="beğeni + yorum + paylaşım + kaydetme"
            />
            <Stat
              label="Etkileşim oranı"
              value={a.totals.views ? pf.format(eng / a.totals.views) : '—'}
            />
            <Stat label="Paylaşım" value={nf.format(a.totals.posts)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Günlük görüntülenme">
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={a.daily} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(d: string) => d.slice(5)}
                    tick={{ fontSize: 11, fill: INK_2 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={(n: number) => nf.format(n)}
                    tick={{ fontSize: 11, fill: INK_2 }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    formatter={(n) => [nf.format(Number(n)), 'Görüntülenme']}
                    labelFormatter={(d) => String(d)}
                  />
                  <Line
                    type="monotone"
                    dataKey="views"
                    stroke={SERIES_1}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>
            <ChartCard title="Günlük etkileşim">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={a.daily} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(d: string) => d.slice(5)}
                    tick={{ fontSize: 11, fill: INK_2 }}
                    tickLine={false}
                    axisLine={{ stroke: GRID }}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={(n: number) => nf.format(n)}
                    tick={{ fontSize: 11, fill: INK_2 }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                  />
                  <Tooltip
                    formatter={(n) => [nf.format(Number(n)), 'Etkileşim']}
                    cursor={{ fill: '#f1f0ec' }}
                  />
                  <Bar dataKey="engagement" fill={SERIES_2} radius={[4, 4, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
          <Heatmap cells={a.heatmap} best={a.best_hours} minN={a.min_posts_per_bucket} />
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-semibold">En çok izlenen paylaşımlar</h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1">Platform</th>
                  <th className="py-1">Video</th>
                  <th className="py-1 text-right">Görüntülenme</th>
                  <th className="py-1 text-right">Etkileşim oranı</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {a.top_posts.map((p) => {
                  const e = p.likes + p.comments + p.shares + p.saves;
                  return (
                    <tr key={p.post_id}>
                      <td className="py-1.5">
                        <PlatformIcon platform={p.platform} size={16} />
                      </td>
                      <td className="py-1.5">
                        {p.url ? (
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-600 hover:underline"
                          >
                            {p.title ?? '—'}
                          </a>
                        ) : (
                          (p.title ?? '—')
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{nf.format(p.views)}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {p.views ? pf.format(e / p.views) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4" title={hint}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Heatmap({
  cells,
  best,
  minN,
}: {
  cells: HeatCell[];
  best: AnalyticsDTO['best_hours'];
  minN: number;
}) {
  const max = Math.max(0, ...cells.filter((c) => c.posts >= minN).map((c) => c.median_rate ?? 0));
  const bestSet = new Set(best.map((b) => `${b.weekday}|${b.hour}`));
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold">Gün × saat etkileşim oranı (ortanca)</h2>
        <span className="text-xs text-slate-500">
          En az {minN} paylaşımı olan saatler renklendirilir · marka saat dilimi
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[720px] grid-cols-[72px_repeat(24,minmax(0,1fr))] gap-[2px] text-[10px]">
          <div />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="text-center text-slate-500">
              {h}
            </div>
          ))}
          {WEEKDAYS.map((d, wi) => (
            <HeatRow
              key={d}
              label={d}
              cells={cells.filter((c) => c.weekday === wi + 1)}
              max={max}
              minN={minN}
              bestSet={bestSet}
            />
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1">
          Düşük
          {SEQ.map((c) => (
            <span key={c} className="inline-block h-3 w-4" style={{ background: c }} />
          ))}
          Yüksek
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded-sm ring-2 ring-pink-400" /> En iyi 3 saat
          (takvimde pembe)
        </span>
      </div>
      {best.length > 0 && (
        <ol className="mt-3 list-decimal pl-5 text-sm">
          {best.map((b) => (
            <li key={`${b.weekday}-${b.hour}`}>
              {WEEKDAYS[b.weekday - 1]} {String(b.hour).padStart(2, '0')}:00 — ortanca oran{' '}
              {pf.format(b.median_rate)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HeatRow({
  label,
  cells,
  max,
  minN,
  bestSet,
}: {
  label: string;
  cells: HeatCell[];
  max: number;
  minN: number;
  bestSet: Set<string>;
}) {
  return (
    <>
      <div className="flex items-center pr-1 text-slate-600">{label}</div>
      {cells.map((c) => {
        const enough = c.posts >= minN;
        const isBest = bestSet.has(`${c.weekday}|${c.hour}`);
        return (
          <div
            key={c.hour}
            className={`h-6 rounded-sm ${isBest ? 'ring-2 ring-inset ring-pink-400' : ''}`}
            style={{ background: enough ? heatColor(c.median_rate, max) : '#f6f5f2' }}
            title={`${label} ${String(c.hour).padStart(2, '0')}:00 · ${c.posts} paylaşım${c.median_rate !== null ? ` · ortanca ${pf.format(c.median_rate)}` : ''}${enough ? '' : ` (en az ${minN} gerekli)`}`}
          />
        );
      })}
    </>
  );
}
