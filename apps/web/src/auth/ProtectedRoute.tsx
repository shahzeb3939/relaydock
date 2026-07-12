import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { FullPageLoader, FullPageOffline } from '../components/Feedback';
import { useAuth } from './AuthProvider';

export function ProtectedRoute() {
  const { loading, retrySession, sessionUnavailable, user } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader label="Opening your dock…" />;
  if (sessionUnavailable) return <FullPageOffline onRetry={retrySession} />;
  if (!user) return <Navigate replace to="/login" state={{ from: location }} />;
  return <Outlet />;
}

export function GuestRoute() {
  const { loading, retrySession, sessionUnavailable, user } = useAuth();
  if (loading) return <FullPageLoader label="Opening RelayDock…" />;
  if (sessionUnavailable) return <FullPageOffline onRetry={retrySession} />;
  if (user) return <Navigate replace to="/devices" />;
  return <Outlet />;
}
