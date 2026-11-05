import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatTr, type AuditDTO, type Paged } from '@socialplan/shared';
import { api } from '../lib/api';
import { ErrorState, Skeleton } from './States';
import { Button } from './ui';

export function AuditLog() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['audit', page],
    queryFn: () => api.get<Paged<AuditDTO>>(`/audit?page=${page}`),
  });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.page_size)) : 1;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-base font-semibold">Audit log</h2>
      {q.isLoading ? (
        <Skeleton rows={4} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr>
                  <th className="py-1 pr-2">Zaman</th>
                  <th className="py-1 pr-2">Kişi</th>
                  <th className="py-1 pr-2">İşlem</th>
                  <th className="py-1">Ayrıntı</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {q.data?.items.map((a) => (
                  <tr key={a.id}>
                    <td className="whitespace-nowrap py-1 pr-2 text-slate-500">{formatTr(a.at)}</td>
                    <td className="py-1 pr-2">{a.actor_email}</td>
                    <td className="py-1 pr-2 font-mono text-xs">{a.action}</td>
                    <td className="max-w-md truncate py-1 text-xs text-slate-500">
                      {a.detail ? JSON.stringify(a.detail) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2 text-sm">
            <Button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ‹
            </Button>
            {page} / {pages}
            <Button disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
              ›
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
