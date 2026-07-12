import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { GuestRoute, ProtectedRoute } from './auth/ProtectedRoute';
import { AppShell } from './components/AppShell';
import { PageLoader } from './components/Feedback';
import { AuthPage } from './pages/AuthPage';
import { DeviceDetailPage } from './pages/DeviceDetailPage';
import { DevicesPage } from './pages/DevicesPage';
import { HistoryPage } from './pages/HistoryPage';
import { RepositoryPage } from './pages/RepositoryPage';

const JobPage = lazy(() =>
  import('./pages/JobPage').then((module) => ({ default: module.JobPage })),
);

export function App() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
          <Route path="/repositories/:repositoryId" element={<RepositoryPage />} />
          <Route
            path="/jobs/:jobId"
            element={
              <Suspense fallback={<PageLoader label="Opening terminal…" />}>
                <JobPage />
              </Suspense>
            }
          />
          <Route path="/history" element={<HistoryPage />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate replace to="/devices" />} />
      <Route path="*" element={<Navigate replace to="/devices" />} />
    </Routes>
  );
}
