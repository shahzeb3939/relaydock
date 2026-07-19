import type { ReactNode } from 'react';
import { humanizeStatus } from '../lib';

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function FullPageLoader({ label }: { label: string }) {
  return (
    <main className="full-page-state">
      <img className="loading-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
      <Spinner />
      <p>{label}</p>
    </main>
  );
}

export function FullPageOffline({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="full-page-state" role="status">
      <img
        className="brand-mark offline-mark"
        src="/icons/icon-192.png"
        alt=""
        aria-hidden="true"
      />
      <h1>RelayDock needs a connection</h1>
      <p>
        Connect to the internet to reach your RelayDock server. Jobs already accepted by your laptop
        continue running, and their missing output will replay when you reconnect.
      </p>
      <button className="button secondary" type="button" onClick={onRetry}>
        Try again
      </button>
    </main>
  );
}

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-state" role="status">
      <Spinner />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({
  title = 'We hit a snag',
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="page-state error-state" role="alert">
      <span className="state-icon" aria-hidden="true">
        !
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      {onRetry && (
        <button className="button secondary" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon = '·',
  title,
  message,
  action,
}: {
  icon?: string;
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase().replaceAll('_', '-');
  return (
    <span className={`status-badge status-${normalized}`}>
      <span className="status-dot" aria-hidden="true" />
      {humanizeStatus(status)}
    </span>
  );
}

export function InlineAlert({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'warning' | 'danger';
}) {
  return (
    <div className={`inline-alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span aria-hidden="true">{tone === 'info' ? 'i' : '!'}</span>
      <div>{children}</div>
    </div>
  );
}
