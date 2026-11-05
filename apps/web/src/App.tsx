import { NavLink, Navigate, Route, Routes } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { MeDTO } from '@socialplan/shared';
import { api } from './lib/api';

const NAV = [
  { to: '/analiz', label: 'Analiz' },
  { to: '/planlama', label: 'Planlama' },
  { to: '/videolar', label: 'Videolar' },
  { to: '/hesaplar', label: 'Hesaplar' },
  { to: '/ayarlar', label: 'Ayarlar' },
];

function Placeholder({ title }: { title: string }) {
  return <div className="p-6 text-slate-500">{title}</div>;
}

export function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<MeDTO>('/me') });
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-6 border-b border-slate-200 bg-white px-4">
        <span className="font-semibold text-brand-600">SocialPlan</span>
        <nav className="flex gap-1 overflow-x-auto text-sm">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <span className="ml-auto truncate text-xs text-slate-500">{me.data?.email}</span>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/planlama" replace />} />
          <Route path="/analiz" element={<Placeholder title="Analiz" />} />
          <Route path="/planlama/*" element={<Placeholder title="Planlama" />} />
          <Route path="/videolar" element={<Placeholder title="Videolar" />} />
          <Route path="/hesaplar" element={<Placeholder title="Hesaplar" />} />
          <Route path="/ayarlar" element={<Placeholder title="Ayarlar" />} />
          <Route path="*" element={<Placeholder title="Sayfa bulunamadı" />} />
        </Routes>
      </main>
    </div>
  );
}
