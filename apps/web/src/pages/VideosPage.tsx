import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQueryClient } from '@tanstack/react-query';
import type { VideoDTO, VideoStatus } from '@socialplan/shared';
import { useBrand } from '../lib/brand';
import { qk, useVideos } from '../lib/hooks';
import { api } from '../lib/api';
import { UploadPanel } from '../components/UploadPanel';
import { VideoDetail } from '../components/VideoDetail';
import { ValidationBadges } from '../components/ValidationBadges';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge, formatDuration } from '../components/ui';

const STATUS_LABEL: Record<VideoStatus, string> = {
  uploading: 'Yükleniyor',
  ready: 'Kuyrukta',
  invalid: 'Uygun değil',
  assigned: 'Planlandı',
  published: 'Yayınlandı',
  archived: 'Arşiv',
};

export function VideosPage() {
  const { brand, brandId, isLoading: brandsLoading } = useBrand();
  const videos = useVideos(brandId);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const queue = useMemo(
    () => (videos.data ?? []).filter((v) => v.status === 'ready'),
    [videos.data],
  );
  const others = useMemo(
    () => (videos.data ?? []).filter((v) => v.status !== 'ready' && v.status !== 'uploading'),
    [videos.data],
  );
  const selectedVideo = (videos.data ?? []).find((v) => v.id === selected) ?? null;

  if (brandsLoading) return <Skeleton rows={6} className="p-6" />;
  if (!brand || !brandId)
    return (
      <div className="p-6">
        <EmptyState title="Önce bir marka ekleyin">
          Üstteki marka seçiciden "Marka ekle".
        </EmptyState>
      </div>
    );

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = queue.findIndex((v) => v.id === active.id);
    const newIdx = queue.findIndex((v) => v.id === over.id);
    const moved = arrayMove(queue, oldIdx, newIdx);
    const i = moved.findIndex((v) => v.id === active.id);
    qc.setQueryData<VideoDTO[]>(qk.videos(brandId), (old) =>
      old ? [...moved, ...old.filter((v) => v.status !== 'ready')] : old,
    );
    try {
      await api.post(`/videos/${String(active.id)}/reorder`, {
        before_id: moved[i - 1]?.id ?? null,
        after_id: moved[i + 1]?.id ?? null,
      });
    } finally {
      await qc.invalidateQueries({ queryKey: qk.videos(brandId) });
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <UploadPanel brandId={brandId} />
      <section>
        <div className="mb-2 flex items-baseline gap-2">
          <h2 className="text-base font-semibold">Kuyruk</h2>
          <span className="text-sm text-slate-500">
            {queue.length} video · sürükleyerek sıralayın (ilk sıradaki ilk paylaşılır)
          </span>
        </div>
        {videos.isLoading ? (
          <Skeleton rows={4} />
        ) : videos.error ? (
          <ErrorState error={videos.error} onRetry={() => void videos.refetch()} />
        ) : queue.length === 0 ? (
          <EmptyState title="Kuyruk boş">Yukarıdan video yükleyin.</EmptyState>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={(e) => void onDragEnd(e)}
          >
            <SortableContext items={queue.map((v) => v.id)} strategy={verticalListSortingStrategy}>
              <ol className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                {queue.map((v, i) => (
                  <SortableRow key={v.id} video={v} index={i} onOpen={() => setSelected(v.id)} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </section>
      {others.length > 0 && (
        <section>
          <h2 className="mb-2 text-base font-semibold">Diğer videolar</h2>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {others.map((v) => (
              <li key={v.id}>
                <VideoRow video={v} onOpen={() => setSelected(v.id)} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <VideoDetail video={selectedVideo} onClose={() => setSelected(null)} />
    </div>
  );
}

function SortableRow({
  video,
  index,
  onOpen,
}: {
  video: VideoDTO;
  index: number;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: video.id,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10 bg-brand-50 shadow' : ''}
    >
      <div className="flex items-center">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab px-3 py-4 text-slate-400 hover:text-slate-600"
          aria-label={`${index + 1}. videoyu taşı`}
        >
          ⋮⋮
        </button>
        <span className="w-6 text-xs text-slate-400">{index + 1}</span>
        <div className="flex-1">
          <VideoRow video={video} onOpen={onOpen} />
        </div>
      </div>
    </li>
  );
}

function VideoRow({ video, onOpen }: { video: VideoDTO; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-2 py-2 text-left hover:bg-slate-50"
    >
      <div className="h-14 w-8 shrink-0 overflow-hidden rounded bg-slate-100">
        {video.thumbnail_url && (
          <img src={video.thumbnail_url} alt="" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{video.title || video.original_name}</p>
        <p className="text-xs text-slate-500">
          {formatDuration(video.duration_ms)} · {video.width}×{video.height}
          {video.ai_generated && ' · YZ'}
        </p>
      </div>
      {video.duplicate_warning && (
        <Badge tone="amber" title={video.duplicate_warning}>
          Yinelenen
        </Badge>
      )}
      <ValidationBadges validation={video.validation} compact />
      <Badge
        tone={video.status === 'invalid' ? 'red' : video.status === 'published' ? 'green' : 'slate'}
      >
        {STATUS_LABEL[video.status]}
      </Badge>
    </button>
  );
}
