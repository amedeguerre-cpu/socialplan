import { NavLink, Navigate, Route, Routes } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { MeDTO } from '@socialplan/shared';
import { api } from './lib/api';
import { useSettings } from './lib/hooks';
import { BrandProvider } from './lib/brand';
import { BrandSwitcher } from './components/BrandSwitcher';
import { VideosPage } from './pages/VideosPage';
import { PlanningPage } from './pages/PlanningPage';
import { SettingsPage } from './pages/SettingsPage';
import { AccountsPage } from './pages/AccountsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { HealthDot, HealthPage } from './pages/HealthPage';

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
    <BrandProvider>
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-6 border-b border-slate-200 bg-white px-4">
          <span className="font-semibold text-brand-600">SocialPlan</span>
          <BrandSwitcher />
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
          <span className="ml-auto" />
          <HealthDot />
          <span className="truncate text-xs text-slate-500">{me.data?.email}</span>
        </header>
        <SafetyBanner />
        <main className="min-h-0 flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Navigate to="/planlama" replace />} />
            <Route path="/analiz" element={<AnalyticsPage />} />
            <Route path="/saglik" element={<HealthPage />} />
            <Route path="/planlama/*" element={<PlanningPage />} />
            <Route path="/videolar" element={<VideosPage />} />
            <Route path="/hesaplar" element={<AccountsPage />} />
            <Route path="/ayarlar" element={<SettingsPage />} />
            <Route path="*" element={<Placeholder title="Sayfa bulunamadı" />} />
          </Routes>
        </main>
      </div>
    </BrandProvider>
  );
}

function SafetyBanner() {
  const s = useSettings();
  if (!s.data) return null;
  if (s.data.kill_switch) {
    return (
      <div
        role="alert"
        className="bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white"
      >
        Kill switch AÇIK — yeni paylaşım başlamaz, devam edenler durdurulur. Ayarlar'dan
        kapatabilirsiniz.
      </div>
    );
  }
  if (s.data.dry_run) {
    return (
      <div className="bg-violet-50 px-4 py-1 text-center text-xs text-violet-800">
        DRY_RUN açık — platformlara hiçbir istek gönderilmez; paylaşımlar "yayınlandı (dry-run)"
        olur.
      </div>
    );
  }
  return null;
}
