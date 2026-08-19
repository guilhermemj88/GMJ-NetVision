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
import { getMe, login as loginRequest, logout as logoutRequest } from '@/lib/api';
import type { AuthUser, LoginInput } from '@gmj/shared';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  signIn: (input: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  signIn: async () => undefined,
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
  const [checkedPath, setCheckedPath] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (isPublicPath(pathname)) {
      setUser(null);
      setLoading(false);
      setCheckedPath(pathname);
      return;
    }

    let cancelled = false;
    setLoading(true);
    getMe()
      .then((response) => {
        if (cancelled) return;
        setUser(response.user);
        setCheckedPath(pathname);
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setCheckedPath(pathname);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!loading && checkedPath === pathname && !user && !isPublicPath(pathname)) {
      router.replace('/login');
    }
  }, [loading, checkedPath, user, pathname, router]);

  const signIn = useCallback(async (input: LoginInput) => {
    const response = await loginRequest(input);
    setUser(response.user);
    setCheckedPath('/');
    setLoading(false);
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest().catch(() => undefined);
    setUser(null);
    setLoading(false);
    setCheckedPath('/login');
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
      <AuthContext.Provider value={{ user, loading, signIn, logout }}>
        {children}
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
