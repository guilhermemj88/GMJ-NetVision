'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { getMe, logout as logoutRequest } from '@/lib/api';
import type { AuthUser } from '@gmj/shared';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  logout: async () => undefined,
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/view/');
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
          mutations: { retry: 0 },
        },
      }),
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const response = await getMe();
      setUser(response.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPublicPath(pathname)) {
      setUser(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    if (!loading && !user && !isPublicPath(pathname)) {
      router.replace('/login');
    }
  }, [loading, user, pathname, router]);

  const logout = useCallback(async () => {
    await logoutRequest().catch(() => undefined);
    setUser(null);
    setLoading(false);
    router.replace('/login');
  }, [router]);

  if (loading && !isPublicPath(pathname)) {
    return (
      <div className="auth-loading">
        <span className="map-loading__radar" />
        <strong>Verificando sessão</strong>
      </div>
    );
  }

  return (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={{ user, loading, logout }}>{children}</AuthContext.Provider>
    </QueryClientProvider>
  );
}
