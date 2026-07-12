import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { Brand } from './Brand';

const navigation = [
  { to: '/devices', label: 'Devices', glyph: 'D' },
  { to: '/history', label: 'History', glyph: 'H' },
];

function titleForPath(pathname: string): string {
  if (pathname.startsWith('/jobs/')) return 'Session';
  if (pathname === '/history') return 'Job history';
  if (pathname.startsWith('/repositories/')) return 'Repository';
  if (/^\/devices\/.+/.test(pathname)) return 'Device';
  return 'Your devices';
}

export function AppShell() {
  const { user, logout } = useAuth();
  const online = useOnlineStatus();
  const location = useLocation();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="app-layout">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <nav className="side-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'active' : undefined)}
            >
              <span className="nav-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="avatar" aria-hidden="true">
            {user?.email.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <strong>{user?.email}</strong>
            <button type="button" onClick={() => void handleLogout()} disabled={loggingOut}>
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>

      <div className="app-main">
        {!online && (
          <div className="network-banner" role="status">
            You’re offline. Live sessions will reconnect automatically.
          </div>
        )}
        <header className="mobile-header">
          <Brand compact />
          <strong>{titleForPath(location.pathname)}</strong>
          <span
            className={`network-indicator ${online ? 'online' : 'offline'}`}
            title={online ? 'Online' : 'Offline'}
          />
        </header>
        <main id="main-content" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Primary navigation">
        {navigation.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
          >
            <span className="nav-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
