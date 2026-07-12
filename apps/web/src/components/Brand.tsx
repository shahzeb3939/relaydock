import { Link } from 'react-router-dom';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" to="/devices" aria-label="RelayDock devices">
      <span className="brand-mark" aria-hidden="true">
        RD
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>RelayDock</strong>
          <small>Remote dev sessions</small>
        </span>
      )}
    </Link>
  );
}
