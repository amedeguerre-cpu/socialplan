import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatTr,
  PLATFORMS,
  PLATFORM_LABELS,
  POST_STATUSES,
  POST_STATUS_LABELS,
  zonedToUtc,
  type Paged,
  type PostDTO,
} from '@socialplan/shared';
import { api, qs } from '../lib/api';
import { useBrand } from '../lib/brand';
import { useInvalidate } from '../lib/hooks';
import { PlatformIcon } from './PlatformIcon';
import { StatusDot } from './StatusDot';
import { EmptyState, ErrorState, Skeleton } from './States';
import { Button, inputCls } from './ui';

export function PostList({ onOpen }: { onOpen: (id: string) => void }) {
  const { brandId, brand } = useBrand();
  const tz = brand?.timezone ?? 'Europe/Istanbul';
  const inv = useInvalidate();
  const [f, setF] = useState({
    platform: '',
    status: '',
    from: '',
    to: '',
    q: '',
    page: 1,
    all: false,
  });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const params = qs({
    brand_id: f.all ? undefined : (brandId ?? undefined),
    platform: f.platform,
    status: f.status,
    from: f.from ? zonedToUtc(f.from, '00:00', tz).toISOString() : undefined,
    to: f.to ? zonedToUtc(f.to, '23:59', tz).toISOString() : undefined,
    q: f.q,
    page: f.page,
    page_size: 50,
  });
  const list = useQuery({
    queryKey: ['posts', params],
    queryFn: () => api.get<Paged<PostDTO>>(`/posts${params}`),
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1;
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, page: 1, ...patch }));

  const bulk = async (action: 'cancel' | 'retry') => {
    if (action === 'cancel' && !confirm(`${sel.size} paylaşım iptal edilsin mi?`)) return;
    await api.post('/posts/bulk', { ids: [...sel], action });
    setSel(new Set());
    await inv(['posts'], ['videos'], ['brands']);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={f.all} onChange={(e) => set({ all: e.target.checked })} />{' '}
          Tüm markalar
        </label>
        <select
          value={f.platform}
          onChange={(e) => set({ platform: e.target.value })}
          className={`${inputCls} w-36`}
          aria-label="Platform"
        >
          <option value="">Tüm platformlar</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
        <select
          value={f.status}
          onChange={(e) => set({ status: e.target.value })}
          className={`${inputCls} w-40`}
          aria-label="Durum"
        >
          <option value="">Tüm durumlar</option>
          {POST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {POST_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={f.from}
          onChange={(e) => set({ from: e.target.value })}
          className={`${inputCls} w-40`}
          aria-label="Başlangıç"
        />
        <input
          type="date"
          value={f.to}
          onChange={(e) => set({ to: e.target.value })}
          className={`${inputCls} w-40`}
          aria-label="Bitiş"
        />
        <input
          value={f.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Ara…"
          className={`${inputCls} w-48`}
        />
        <span className="flex-1" />
        {sel.size > 0 && (
          <>
            <span className="text-slate-500">{sel.size} seçili</span>
            <Button onClick={() => void bulk('retry')}>Tekrar dene</Button>
            <Button variant="danger" onClick={() => void bulk('cancel')}>
              İptal et
            </Button>
          </>
        )}
      </div>
      {list.isLoading ? (
        <Skeleton rows={8} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data?.items.length ? (
        <EmptyState title="Paylaşım yok">Filtreleri değiştirin veya video planlayın.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="w-8 p-2">
                  <input
                    type="checkbox"
                    aria-label="Tümünü seç"
                    checked={list.data.items.every((p) => sel.has(p.id))}
                    onChange={(e) =>
                      setSel(
                        e.target.checked ? new Set(list.data.items.map((p) => p.id)) : new Set(),
                      )
                    }
                  />
                </th>
                <th className="p-2">Zaman</th>
                <th className="p-2">Platform</th>
                <th className="p-2">Video</th>
                <th className="p-2">Durum</th>
                <th className="p-2">Not</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.data.items.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => onOpen(p.id)}
                >
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label="Seç"
                      checked={sel.has(p.id)}
                      onChange={(e) =>
                        setSel((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(p.id);
                          else n.delete(p.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="whitespace-nowrap p-2">{formatTr(p.scheduled_at, tz)}</td>
                  <td className="p-2">
                    <PlatformIcon platform={p.platform} />
                  </td>
                  <td className="max-w-xs truncate p-2">{p.video_title}</td>
                  <td className="whitespace-nowrap p-2">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot status={p.status} />
                      {POST_STATUS_LABELS[p.status]}
                    </span>
                  </td>
                  <td className="max-w-xs truncate p-2 text-xs text-slate-500">
                    {p.last_error_message ?? (p.visibility === 'dry-run' ? 'dry-run' : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t border-slate-100 p-2 text-sm text-slate-600">
            <span>{list.data.total} paylaşım</span>
            <span className="flex items-center gap-2">
              <Button
                disabled={f.page <= 1}
                onClick={() => setF((x) => ({ ...x, page: x.page - 1 }))}
              >
                ‹
              </Button>
              {f.page} / {pages}
              <Button
                disabled={f.page >= pages}
                onClick={() => setF((x) => ({ ...x, page: x.page + 1 }))}
              >
                ›
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
