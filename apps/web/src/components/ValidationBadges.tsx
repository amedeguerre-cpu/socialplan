import { PLATFORMS, type ValidationResult } from '@socialplan/shared';
import { PlatformIcon } from './PlatformIcon';

export function ValidationBadges({
  validation,
  compact = false,
}: {
  validation: ValidationResult | null;
  compact?: boolean;
}) {
  if (!validation) return null;
  return (
    <div className={compact ? 'flex gap-1' : 'space-y-1'}>
      {PLATFORMS.map((p) => {
        const r = validation[p];
        const errors = r.issues.filter((i) => i.severity === 'error');
        const warnings = r.issues.filter((i) => i.severity === 'warning');
        const title = r.issues.map((i) => i.message).join('\n') || 'Uygun';
        if (compact) {
          return (
            <span key={p} title={title} className="relative">
              <PlatformIcon platform={p} size={16} muted={!r.ok} />
              {!r.ok && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
              )}
              {r.ok && warnings.length > 0 && (
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-400" />
              )}
            </span>
          );
        }
        return (
          <div key={p} className="flex items-start gap-2 text-sm">
            <PlatformIcon platform={p} size={18} muted={!r.ok} />
            <div>
              <span className={r.ok ? 'text-emerald-700' : 'text-red-700'}>
                {r.ok ? 'Uygun' : 'Uygun değil'}
              </span>
              {[...errors, ...warnings].map((i) => (
                <p
                  key={i.code}
                  className={`text-xs ${i.severity === 'error' ? 'text-red-600' : 'text-amber-700'}`}
                >
                  {i.message}
                </p>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
