/** Haftalık takvim: saat satırları × günler, sürükle-bırak yeniden zamanlama, boş slotlar, en iyi saatler. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useQuery } from '@tanstack/react-query';
import {
  addDaysYmd,
  hmInTz,
  weekdayOfYmd,
  weekStartYmd,
  ymdInTz,
  zonedToUtc,
  type AnalyticsDTO,
  type Paged,
  type PostDTO,
  type SlotDTO,
} from '@socialplan/shared';
import { api } from '../lib/api';
import { useBrand } from '../lib/brand';
import { useInvalidate, useSlots, useVideos } from '../lib/hooks';
import { PlatformIcon } from './PlatformIcon';
import { StatusDot } from './StatusDot';
import { EmptyState, ErrorState, Skeleton } from './States';
import { Button, inputCls, Modal } from './ui';

const DAY_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const MOVABLE = new Set(['draft', 'scheduled', 'needs_action', 'failed']);

export interface CalendarCell {
  ymd: string;
  hour: number;
}

/** Bir haftanın günleri (pazartesiden). */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysYmd(weekStart, i));
}

/** Post'ları marka saat diliminde gün × saat hücrelerine yerleştir. */
export function bucketPosts(posts: PostDTO[], tz: string): Map<string, PostDTO[]> {
  const m = new Map<string, PostDTO[]>();
  for (const p of posts) {
    const key = `${ymdInTz(p.scheduled_at, tz)}|${Number(hmInTz(p.scheduled_at, tz).slice(0, 2))}`;
    const arr = m.get(key) ?? [];
    arr.push(p);
    m.set(key, arr);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return m;
}

/** Sürüklenen post'un yeni UTC zamanı: hedef gün/saat, dakika korunur (slot hedefinde slot saati). */
export function dropTarget(
  post: PostDTO,
  target: { ymd: string; hour: number; hm?: string },
  tz: string,
): string {
  const minute = hmInTz(post.scheduled_at, tz).slice(3);
  const hm = target.hm ?? `${String(target.hour).padStart(2, '0')}:${minute}`;
  return zonedToUtc(target.ymd, hm, tz).toISOString();
}

export function CalendarView({ onOpen }: { onOpen: (id: string) => void }) {
  const { brand, brandId } = useBrand();
  const tz = brand?.timezone ?? 'Europe/Istanbul';
  const [week, setWeek] = useState(() => weekStartYmd(new Date(), tz));
  const [q, setQ] = useState('');
  const [assign, setAssign] = useState<{ ymd: string; slot: SlotDTO } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const inv = useInvalidate();
  const days = weekDays(week);
  const from = zonedToUtc(week, '00:00', tz).toISOString();
  const to = zonedToUtc(addDaysYmd(week, 7), '00:00', tz).toISOString();
  const posts = useQuery({
    queryKey: ['posts', 'calendar', brandId, from],
    queryFn: () =>
      api.get<Paged<PostDTO>>(
        `/posts?brand_id=${brandId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page_size=200`,
      ),
    enabled: !!brandId,
    refetchInterval: 15_000,
  });
  const slots = useSlots(brandId);
  const analytics = useQuery({
    queryKey: ['analytics', brandId, 'best'],
    queryFn: () => api.get<AnalyticsDTO>(`/analytics?brand_id=${brandId}&days=90`),
    enabled: !!brandId,
    retry: false,
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const scroller = useRef<HTMLDivElement>(null);
  const loaded = posts.isSuccess;
  useEffect(() => {
    // Sabah saatlerinden başla (gece satırları yukarıda kalır).
    if (loaded) scroller.current?.scrollTo({ top: 7 * 56 });
  }, [brandId, loaded]);

  const visible = useMemo(() => {
    const items = (posts.data?.items ?? []).filter((p) => p.status !== 'cancelled');
    const needle = q.trim().toLocaleLowerCase('tr');
    return needle
      ? items.filter((p) =>
          `${p.video_title ?? ''} ${p.caption_snapshot ?? ''}`
            .toLocaleLowerCase('tr')
            .includes(needle),
        )
      : items;
  }, [posts.data, q]);
  const buckets = useMemo(() => bucketPosts(visible, tz), [visible, tz]);
  const best = useMemo(
    () => new Set((analytics.data?.best_hours ?? []).map((b) => `${b.weekday}|${b.hour}`)),
    [analytics.data],
  );
  const today = ymdInTz(new Date(), tz);
  const nowMs = Date.now();

  const slotsAt = (ymd: string, hour: number): SlotDTO[] =>
    (slots.data ?? []).filter(
      (s) =>
        s.active && s.weekday === weekdayOfYmd(ymd) && Number(s.time_local.slice(0, 2)) === hour,
    );
  const filled = (ymd: string, slot: SlotDTO): boolean =>
    visible.some((p) => p.slot_id === slot.id && ymdInTz(p.scheduled_at, tz) === ymd) ||
    visible.some(
      (p) => ymdInTz(p.scheduled_at, tz) === ymd && hmInTz(p.scheduled_at, tz) === slot.time_local,
    );

  const onDragEnd = async (e: DragEndEvent) => {
    const post = visible.find((p) => p.id === e.active.id);
    const over = e.over?.data.current as { ymd: string; hour: number; hm?: string } | undefined;
    if (!post || !over) return;
    const iso = dropTarget(post, over, tz);
    if (iso === post.scheduled_at) return;
    if (new Date(iso).getTime() < Date.now()) {
      setMsg('Geçmiş bir zamana taşınamaz');
      return;
    }
    try {
      await api.patch(`/posts/${post.id}`, { scheduled_at: iso });
      setMsg(null);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Taşınamadı');
    }
    await inv(['posts']);
  };

  if (!brandId) return <EmptyState title="Önce bir marka ekleyin" />;
  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setWeek((w) => addDaysYmd(w, -7))} aria-label="Önceki hafta">
          ‹
        </Button>
        <Button onClick={() => setWeek(weekStartYmd(new Date(), tz))}>Bu hafta</Button>
        <Button onClick={() => setWeek((w) => addDaysYmd(w, 7))} aria-label="Sonraki hafta">
          ›
        </Button>
        <span className="text-sm font-medium">
          {new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(
            new Date(`${week}T12:00:00Z`),
          )}{' '}
          –{' '}
          {new Intl.DateTimeFormat('tr-TR', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }).format(new Date(`${addDaysYmd(week, 6)}T12:00:00Z`))}
        </span>
        <span className="text-xs text-slate-500">({tz})</span>
        <span className="flex-1" />
        {msg && <span className="text-sm text-red-600">{msg}</span>}
        {best.size > 0 && (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <span className="inline-block h-3 w-3 rounded-sm bg-pink-100 ring-1 ring-pink-200" /> En
            iyi saatler
          </span>
        )}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ara…"
          className={`${inputCls} w-44`}
          aria-label="Takvimde ara"
        />
      </div>
      {posts.isLoading ? (
        <Skeleton rows={10} />
      ) : posts.error ? (
        <ErrorState error={posts.error} onRetry={() => void posts.refetch()} />
      ) : (
        <DndContext sensors={sensors} onDragEnd={(e) => void onDragEnd(e)}>
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white"
          >
            <div className="grid min-w-[880px] grid-cols-[56px_repeat(7,minmax(112px,1fr))]">
              <div className="sticky top-0 z-20 border-b border-slate-200 bg-white" />
              {days.map((d, i) => (
                <div
                  key={d}
                  className={`sticky top-0 z-20 border-b border-l border-slate-200 bg-white px-2 py-2 text-center text-xs ${d === today ? 'font-semibold text-brand-700' : 'text-slate-600'}`}
                >
                  {DAY_SHORT[i]}{' '}
                  <span
                    className={
                      d === today ? 'rounded-full bg-brand-600 px-1.5 py-0.5 text-white' : ''
                    }
                  >
                    {Number(d.slice(8))}
                  </span>
                </div>
              ))}
              {Array.from({ length: 24 }, (_, hour) => (
                <HourRow
                  key={hour}
                  hour={hour}
                  days={days}
                  tz={tz}
                  nowMs={nowMs}
                  best={best}
                  buckets={buckets}
                  slotsAt={slotsAt}
                  filled={filled}
                  onOpen={onOpen}
                  onAssign={(ymd, slot) => setAssign({ ymd, slot })}
                />
              ))}
            </div>
          </div>
        </DndContext>
      )}
      <AssignModal target={assign} onClose={() => setAssign(null)} />
    </div>
  );
}

interface RowProps {
  hour: number;
  days: string[];
  tz: string;
  nowMs: number;
  best: Set<string>;
  buckets: Map<string, PostDTO[]>;
  slotsAt: (ymd: string, hour: number) => SlotDTO[];
  filled: (ymd: string, slot: SlotDTO) => boolean;
  onOpen: (id: string) => void;
  onAssign: (ymd: string, slot: SlotDTO) => void;
}

function HourRow({
  hour,
  days,
  tz,
  nowMs,
  best,
  buckets,
  slotsAt,
  filled,
  onOpen,
  onAssign,
}: RowProps) {
  return (
    <>
      <div className="h-full min-h-14 border-b border-slate-100 pr-1 pt-1 text-right text-[11px] text-slate-400">
        {String(hour).padStart(2, '0')}:00
      </div>
      {days.map((ymd, i) => {
        const items = buckets.get(`${ymd}|${hour}`) ?? [];
        const free = slotsAt(ymd, hour).filter((s) => !filled(ymd, s));
        const past = zonedToUtc(ymd, `${String(hour).padStart(2, '0')}:59`, tz).getTime() < nowMs;
        return (
          <Cell key={ymd} ymd={ymd} hour={hour} best={best.has(`${i + 1}|${hour}`)} past={past}>
            {items.map((p) => (
              <PostCard key={p.id} post={p} tz={tz} onOpen={() => onOpen(p.id)} />
            ))}
            {!past &&
              free.map((s) => (
                <SlotBox key={s.id} ymd={ymd} slot={s} onClick={() => onAssign(ymd, s)} />
              ))}
          </Cell>
        );
      })}
    </>
  );
}

function Cell({
  ymd,
  hour,
  best,
  past,
  children,
}: {
  ymd: string;
  hour: number;
  best: boolean;
  past: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `cell:${ymd}:${hour}`,
    data: { ymd, hour },
    disabled: past,
  });
  return (
    <div
      ref={setNodeRef}
      data-testid={`cell-${ymd}-${hour}`}
      className={`min-h-14 space-y-1 border-b border-l border-slate-100 p-1 ${best ? 'bg-pink-50' : past ? 'bg-slate-50/60' : ''} ${isOver ? 'ring-2 ring-inset ring-brand-500' : ''}`}
    >
      {children}
    </div>
  );
}

function SlotBox({ ymd, slot, onClick }: { ymd: string; slot: SlotDTO; onClick: () => void }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `slot:${ymd}:${slot.id}`,
    data: { ymd, hour: Number(slot.time_local.slice(0, 2)), hm: slot.time_local },
  });
  return (
    <button
      ref={setNodeRef}
      onClick={onClick}
      className={`flex w-full items-center gap-1 rounded-md border border-dashed px-1.5 py-1 text-[11px] text-slate-400 hover:border-brand-500 hover:text-brand-600 ${isOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300'}`}
      title="Boş slot — video ata"
    >
      <span>{slot.time_local}</span>
      {slot.platforms.map((p) => (
        <PlatformIcon key={p} platform={p} size={12} muted />
      ))}
      <span className="ml-auto">+</span>
    </button>
  );
}

function PostCard({ post, tz, onOpen }: { post: PostDTO; tz: string; onOpen: () => void }) {
  const movable = MOVABLE.has(post.status);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: post.id,
    disabled: !movable,
  });
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 30 }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className={`flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1 text-[11px] shadow-sm hover:border-brand-500 ${isDragging ? 'opacity-80 shadow-lg' : ''} ${movable ? 'cursor-grab' : ''}`}
      title={post.video_title ?? ''}
    >
      {post.thumbnail_url ? (
        <img src={post.thumbnail_url} alt="" className="h-9 w-5 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-9 w-5 shrink-0 rounded bg-slate-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <PlatformIcon platform={post.platform} size={12} />
          <span className="font-medium text-slate-700">{hmInTz(post.scheduled_at, tz)}</span>
          <StatusDot status={post.status} size={7} />
        </div>
        <p className="truncate text-slate-600">{post.video_title || '—'}</p>
      </div>
    </div>
  );
}

function AssignModal({
  target,
  onClose,
}: {
  target: { ymd: string; slot: SlotDTO } | null;
  onClose: () => void;
}) {
  const { brandId } = useBrand();
  const videos = useVideos(brandId);
  const inv = useInvalidate();
  const [err, setErr] = useState<string | null>(null);
  if (!target) return null;
  const queue = (videos.data ?? []).filter((v) => v.status === 'ready');
  const pick = async (videoId: string) => {
    setErr(null);
    try {
      const v = queue.find((x) => x.id === videoId);
      const platforms = target.slot.platforms.filter((p) => v?.validation?.[p].ok !== false);
      await api.post('/posts/manual', {
        video_id: videoId,
        platforms,
        date: target.ymd,
        time: target.slot.time_local,
      });
      await inv(['posts'], ['videos'], ['brands']);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Planlanamadı');
    }
  };
  return (
    <Modal
      open
      title={`${target.ymd} ${target.slot.time_local} slotuna video ata`}
      onClose={onClose}
    >
      {err && <p className="mb-2 text-sm text-red-600">{err}</p>}
      {queue.length === 0 ? (
        <p className="text-sm text-slate-500">Kuyrukta video yok.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto">
          {queue.map((v) => (
            <li key={v.id}>
              <button
                onClick={() => void pick(v.id)}
                className="flex w-full items-center gap-2 px-1 py-2 text-left text-sm hover:bg-slate-50"
              >
                {v.thumbnail_url ? (
                  <img src={v.thumbnail_url} alt="" className="h-10 w-6 rounded object-cover" />
                ) : (
                  <div className="h-10 w-6 rounded bg-slate-100" />
                )}
                <span className="truncate">{v.title || v.original_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
