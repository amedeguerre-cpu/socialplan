import { useState } from 'react';
import { NavLink, Route, Routes, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { useBrand } from '../lib/brand';
import { useInvalidate, useSettings } from '../lib/hooks';
import { PostDetail } from '../components/PostDetail';
import { PostList } from '../components/PostList';
import { CalendarView } from '../components/Calendar';
import { POST_STATUSES, POST_STATUS_LABELS } from '@socialplan/shared';
import { StatusDot } from '../components/StatusDot';
import { Button } from '../components/ui';

export function PlanningPage() {
  const [params, setParams] = useSearchParams();
  const postId = params.get('post');
  const open = (id: string) => setParams((p) => (p.set('post', id), p));
  const close = () => setParams((p) => (p.delete('post'), p));
  const { brand } = useBrand();
  const settings = useSettings();
  const inv = useInvalidate();
  const [msg, setMsg] = useState<string | null>(null);
  const fill = async () => {
    if (!brand) return;
    setMsg(null);
    try {
      const r = await api.post<{ created: number; occurrences: number }>('/posts/fill', {
        brand_id: brand.id,
        days: brand.autofill_days || settings.data?.autofill_default_days || 7,
      });
      setMsg(
        r.created
          ? `${r.created} paylaşım planlandı`
          : r.occurrences
            ? 'Kuyrukta uygun video yok'
            : 'Boş slot yok (Ayarlar → Slotlar)',
      );
      await inv(['posts'], ['videos'], ['brands']);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Doldurulamadı');
    }
  };
  const tab = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-white font-medium shadow-sm' : 'text-slate-600'}`;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex rounded-lg bg-slate-100 p-0.5">
          <NavLink end to="/planlama" className={tab}>
            Takvim
          </NavLink>
          <NavLink to="/planlama/liste" className={tab}>
            Liste
          </NavLink>
        </div>
        <span className="flex-1" />
        {msg && <span className="text-sm text-slate-600">{msg}</span>}
        <Button variant="primary" onClick={() => void fill()} disabled={!brand}>
          Kuyruğu doldur
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Routes>
          <Route index element={<CalendarView onOpen={open} />} />
          <Route path="liste" element={<PostList onOpen={open} />} />
        </Routes>
      </div>
      <footer className="flex flex-wrap gap-3 border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
        {POST_STATUSES.map((s) => (
          <span key={s} className="flex items-center gap-1">
            <StatusDot status={s} /> {POST_STATUS_LABELS[s]}
          </span>
        ))}
      </footer>
      <PostDetail postId={postId} onClose={close} />
    </div>
  );
}
