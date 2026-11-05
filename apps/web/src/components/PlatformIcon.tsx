import { PLATFORM_LABELS, type Platform } from '@socialplan/shared';

const COLORS: Record<Platform, string> = {
  instagram: '#d62976',
  youtube: '#ff0000',
  tiktok: '#111827',
};
const GLYPH: Record<Platform, string> = { instagram: 'IG', youtube: 'YT', tiktok: 'TT' };

export function PlatformIcon({
  platform,
  size = 18,
  muted = false,
}: {
  platform: Platform;
  size?: number;
  muted?: boolean;
}) {
  return (
    <span
      title={PLATFORM_LABELS[platform]}
      aria-label={PLATFORM_LABELS[platform]}
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: muted ? '#cbd5e1' : COLORS[platform],
      }}
    >
      {GLYPH[platform]}
    </span>
  );
}
