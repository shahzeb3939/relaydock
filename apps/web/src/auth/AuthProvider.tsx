import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Session, User } from '../api/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  sessionUnavailable: boolean;
  retrySession: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: queryKeys.session,
    queryFn: api.session,
    retry: (attempt, error) => !(error instanceof Error && 'status' in error) && attempt < 2,
    staleTime: 30_000,
  });

  useEffect(() => {
    const invalidateSession = () => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
      });
      queryClient.setQueryData(queryKeys.session, null);
    };
    window.addEventListener('relaydock:unauthorized', invalidateSession);
    return () => window.removeEventListener('relaydock:unauthorized', invalidateSession);
  }, [queryClient]);

  const setSession = (session: Session) => {
    queryClient.setQueryData(queryKeys.session, session);
  };

  const value: AuthContextValue = {
    user: sessionQuery.data?.user ?? null,
    loading: sessionQuery.isPending,
    sessionUnavailable:
      sessionQuery.isError &&
      sessionQuery.error instanceof ApiError &&
      sessionQuery.error.status === 0,
    retrySession: () => {
      void sessionQuery.refetch();
    },
    login: async (email, password) => setSession(await api.login(email, password)),
    register: async (email, password) => setSession(await api.register(email, password)),
    logout: async () => {
      await api.logout();
      // Mark the session resolved-empty first, then drop the other cached data.
      // Using clear() here evicted the session query and triggered an immediate
      // refetch, so route guards briefly still saw the old user and only
      // redirected to /login after a manual refresh. Setting it to null leaves
      // the query resolved (no refetch) so the guards react right away.
      queryClient.setQueryData(queryKeys.session, null);
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.session[0],
      });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider.');
  return context;
}
