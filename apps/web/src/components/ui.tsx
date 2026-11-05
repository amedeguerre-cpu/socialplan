import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const V: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-500/50',
  secondary:
    'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:opacity-50',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...p
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ${V[variant]} ${className}`}
    />
  );
}

export function Badge({
  children,
  tone = 'slate',
  title,
}: {
  children: ReactNode;
  tone?: 'slate' | 'green' | 'red' | 'amber' | 'violet' | 'blue';
  title?: string;
}) {
  const t = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
    blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent ${t}`}
    >
      {children}
    </span>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-xl',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        className={`relative flex h-full w-full ${width} flex-col bg-white shadow-xl`}
      >
        <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-500 hover:bg-slate-100"
            aria-label="Kapat"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </aside>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
      >
        <h2 className="mb-3 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100';

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="flex gap-1 border-b border-slate-200" role="tablist">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${value === it.value ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
