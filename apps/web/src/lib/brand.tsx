import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BrandDTO } from '@socialplan/shared';
import { useBrands } from './hooks';

interface BrandCtx {
  brands: BrandDTO[];
  brand: BrandDTO | null;
  brandId: string | null;
  setBrandId: (id: string) => void;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

const Ctx = createContext<BrandCtx | null>(null);
const KEY = 'socialplan.brand';

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function BrandProvider({ children }: { children: ReactNode }) {
  const q = useBrands();
  const [brandId, setBrandIdState] = useState<string | null>(readStored);
  const brands = useMemo(() => q.data ?? [], [q.data]);
  const brand = brands.find((b) => b.id === brandId) ?? brands[0] ?? null;
  useEffect(() => {
    if (brand && brand.id !== brandId) setBrandIdState(brand.id);
  }, [brand, brandId]);
  const setBrandId = (id: string) => {
    setBrandIdState(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* depolama kapalı */
    }
  };
  return (
    <Ctx.Provider
      value={{
        brands,
        brand,
        brandId: brand?.id ?? null,
        setBrandId,
        isLoading: q.isLoading,
        error: q.error,
        refetch: () => void q.refetch(),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useBrand(): BrandCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('BrandProvider eksik');
  return c;
}
