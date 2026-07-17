import type { UseWebPushResult } from '../hooks/useWebPush';

interface ToggleView {
  icon: string;
  label: string;
  title: string;
  interactive: boolean;
  on: boolean;
}

function viewFor(state: UseWebPushResult['state']): ToggleView | null {
  switch (state) {
    case 'ios-needs-install':
      return {
        icon: '🔔',
        label: 'Add to Home Screen',
        title:
          'On iPhone or iPad, add RelayDock to your Home Screen (Share → Add to Home Screen) to receive notifications.',
        interactive: false,
        on: false,
      };
    case 'denied':
      return {
        icon: '🔕',
        label: 'Notifications blocked',
        title: 'Notifications are blocked for this site. Re-enable them in your browser settings.',
        interactive: false,
        on: false,
      };
    case 'off':
      return {
        icon: '🔔',
        label: 'Enable notifications',
        title: 'Get notified when a session needs input or finishes.',
        interactive: true,
        on: false,
      };
    case 'on':
      return {
        icon: '🔔',
        label: 'Notifications on',
        title: 'Notifications on — tap to turn off.',
        interactive: true,
        on: true,
      };
    // loading / unsupported / unconfigured: nothing actionable to show.
    default:
      return null;
  }
}

// Presentational: the push state/actions are owned by AppShell (one hook
// instance) and passed in, so the sidebar and mobile-header copies stay in
// sync. `compact` renders icon-only for the tight mobile header.
export function NotificationToggle({
  push,
  variant = 'full',
}: {
  push: UseWebPushResult;
  variant?: 'full' | 'compact';
}) {
  const { busy, error, enable, disable } = push;
  const view = viewFor(push.state);
  if (view === null) return null;

  const compact = variant === 'compact';
  const className = [
    'notif-toggle',
    view.on ? 'notif-toggle--on' : '',
    view.interactive ? '' : 'notif-toggle--hint',
  ]
    .filter(Boolean)
    .join(' ');

  // Icon-only is fine for the on/off toggle, but hints (iOS "add to home
  // screen", "blocked") and errors carry essential text — a `title` tooltip is
  // invisible on touch devices, so those must render their label inline even in
  // the compact variant.
  const showLabel = !compact || !view.interactive || error !== null;
  const label = error ?? view.label;

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={view.interactive ? () => void (view.on ? disable() : enable()) : undefined}
        disabled={busy || !view.interactive}
        aria-pressed={view.interactive ? view.on : undefined}
        // Track the visible text so the accessible name matches an on-screen error.
        aria-label={error ?? view.label}
        title={error ?? view.title}
      >
        {busy ? (compact ? '…' : 'Working…') : showLabel ? `${view.icon} ${label}` : view.icon}
      </button>
      {error !== null && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </>
  );
}
