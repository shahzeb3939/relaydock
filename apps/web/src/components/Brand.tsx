import { Link } from 'react-router-dom';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" to="/devices" aria-label="RelayDock devices">
      <img className="brand-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
      {!compact && (
        <span className="brand-copy">
          <strong>RelayDock</strong>
          <small>Remote dev sessions</small>
        </span>
      )}
    </Link>
  );
}
