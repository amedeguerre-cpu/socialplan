import { POST_STATUS_COLORS, POST_STATUS_LABELS, type PostStatus } from '@socialplan/shared';

export function StatusDot({ status, size = 8 }: { status: PostStatus; size?: number }) {
  return (
    <span
      title={POST_STATUS_LABELS[status]}
      className="inline-block shrink-0 rounded-full"
      style={{ width: size, height: size, background: POST_STATUS_COLORS[status] }}
    />
  );
}
