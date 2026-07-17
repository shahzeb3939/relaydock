import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useWebPush } from '../hooks/useWebPush';
import { Brand } from './Brand';
import { NotificationToggle } from './NotificationToggle';

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
  const push = useWebPush();
  const location = useLocation();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      // Unsubscribe this browser's push registration while the session is still
      // valid (the DELETE needs auth), so on a shared machine the subscription
      // can't keep delivering this user's job notifications to the next person.
      // Called unconditionally: disable() no-ops when nothing is subscribed, and
      // the browser state can be 'off'/'loading' while a live subscription still
      // exists (e.g. a transient reconcile failure), so gating on 'on' would leak.
      await push.disable();
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
            <NotificationToggle push={push} />
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
          <div className="mobile-header-actions">
            <NotificationToggle push={push} variant="compact" />
            <span
              className={`network-indicator ${online ? 'online' : 'offline'}`}
              title={online ? 'Online' : 'Offline'}
            />
            <button
              type="button"
              className="mobile-signout"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
            >
              {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
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
