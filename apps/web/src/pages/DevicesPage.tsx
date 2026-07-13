import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Device, PairingCode } from '../api/types';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageLoader,
  Spinner,
  StatusBadge,
} from '../components/Feedback';
import { Modal } from '../components/Modal';
import { errorMessage, formatRelativeTime } from '../lib';
import { buildAgentInstallCommand } from '../lib/agentInstall';

function DeviceCard({ device, onRevoke }: { device: Device; onRevoke: (device: Device) => void }) {
  return (
    <article className="device-card">
      <div className="device-card-top">
        <div className={`device-icon ${device.status}`} aria-hidden="true">
          {device.platform.toLowerCase().includes('darwin') ||
          device.platform.toLowerCase().includes('mac')
            ? 'M'
            : 'PC'}
        </div>
        <StatusBadge status={device.status} />
      </div>
      <div className="device-card-copy">
        <h2>{device.name}</h2>
        <p>
          {device.platform} · {device.architecture}
        </p>
      </div>
      <dl className="device-stats">
        <div>
          <dt>Repositories</dt>
          <dd>{device.repositoryCount ?? 0}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>{device.status === 'online' ? 'Now' : formatRelativeTime(device.lastSeenAt)}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>v{device.agentVersion}</dd>
        </div>
      </dl>
      <div className="card-actions">
        <Link className="button secondary" to={`/devices/${device.id}`}>
          Open device <span aria-hidden="true">→</span>
        </Link>
        <button className="button quiet danger-text" type="button" onClick={() => onRevoke(device)}>
          Revoke
        </button>
      </div>
    </article>
  );
}

export function PairDeviceModal({
  pairing,
  loading,
  error,
  onClose,
  onGenerate,
}: {
  pairing: PairingCode | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onGenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const command = pairing ? buildAgentInstallCommand(window.location.origin, pairing.code) : '';
  const copy = async () => {
    setCopied(false);
    setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyError('Could not copy automatically. Select and copy the command manually.');
    }
  };
  const regenerate = () => {
    setCopied(false);
    setCopyError(null);
    onGenerate();
  };

  return (
    <Modal
      title="Add a device"
      description="Install, pair, and keep RelayDock running with one command."
      onClose={onClose}
    >
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {!pairing ? (
        <div className="pairing-intro">
          <ol className="steps">
            <li>
              <span>1</span>
              <p>Generate a short-lived setup code.</p>
            </li>
            <li>
              <span>2</span>
              <p>
                Copy the command and run it once in Terminal on the device you want to add. No Go
                installation or repository checkout is needed.
              </p>
            </li>
            <li>
              <span>3</span>
              <p>
                The installer pairs the device and starts RelayDock automatically whenever you log
                in, including after a restart.
              </p>
            </li>
          </ol>
          <button
            className="button primary full-width"
            type="button"
            disabled={loading}
            onClick={onGenerate}
          >
            {loading && <Spinner />}
            {loading ? 'Generating…' : 'Generate pairing code'}
          </button>
        </div>
      ) : (
        <div className="pairing-result">
          <p className="muted">
            This code expires {formatRelativeTime(pairing.expiresAt)} and can be used only once.
          </p>
          <div className="pairing-code" aria-label={`Pairing code ${pairing.code}`}>
            {pairing.code}
          </div>
          <div className="pairing-command">
            <span className="pairing-command-label">Run this once in Terminal</span>
            <div className="copy-field">
              <code aria-label="RelayDock setup command">{command}</code>
              <button type="button" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy command'}
              </button>
            </div>
          </div>
          {copyError && <InlineAlert tone="danger">{copyError}</InlineAlert>}
          <InlineAlert>
            Pairing is saved on this device, so you do not need to pair it again after closing
            Terminal or restarting. Pair again only if you revoke the device or delete its local
            agent configuration.
          </InlineAlert>
          <p className="pairing-detail">
            RelayDock uses the device hostname as its name and runs in the background after setup.
            It should appear here within a few seconds.
          </p>
          <button
            className="button secondary full-width"
            type="button"
            disabled={loading}
            onClick={regenerate}
          >
            {loading && <Spinner />}
            {loading ? 'Generating…' : 'Regenerate code'}
          </button>
        </div>
      )}
    </Modal>
  );
}

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<Device | null>(null);
  const devicesQuery = useQuery({
    queryKey: queryKeys.devices,
    queryFn: api.devices,
    refetchInterval: 15_000,
  });
  const pairingMutation = useMutation({ mutationFn: api.pairDevice, onSuccess: setPairing });
  const revokeMutation = useMutation({
    mutationFn: api.revokeDevice,
    onSuccess: async () => {
      setRevokeTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
  const closePairing = useCallback(() => {
    setPairingOpen(false);
    setPairing(null);
    pairingMutation.reset();
  }, [pairingMutation]);

  if (devicesQuery.isPending) return <PageLoader label="Finding your devices…" />;
  if (devicesQuery.isError) {
    return (
      <ErrorState
        message={errorMessage(devicesQuery.error)}
        onRetry={() => void devicesQuery.refetch()}
      />
    );
  }

  const devices = devicesQuery.data;
  const onlineCount = devices.filter((device) => device.status === 'online').length;

  return (
    <div className="page devices-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">FLEET</span>
          <h1>Your devices</h1>
          <p>
            {devices.length === 0
              ? 'Connect your first development machine.'
              : `${onlineCount} of ${devices.length} devices online`}
          </p>
        </div>
        <button className="button primary" type="button" onClick={() => setPairingOpen(true)}>
          <span aria-hidden="true">+</span> Add device
        </button>
      </header>

      {devices.length === 0 ? (
        <EmptyState
          icon="D"
          title="No devices connected"
          message="Pair the RelayDock agent running on your laptop. No inbound ports or public IP address are needed."
          action={
            <button className="button primary" type="button" onClick={() => setPairingOpen(true)}>
              Add your first device
            </button>
          }
        />
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <DeviceCard key={device.id} device={device} onRevoke={setRevokeTarget} />
          ))}
        </div>
      )}

      {pairingOpen && (
        <PairDeviceModal
          pairing={pairing}
          loading={pairingMutation.isPending}
          error={pairingMutation.isError ? errorMessage(pairingMutation.error) : null}
          onClose={closePairing}
          onGenerate={() => pairingMutation.mutate()}
        />
      )}

      {revokeTarget && (
        <Modal
          title={`Revoke ${revokeTarget.name}?`}
          description="The device credential will stop working immediately."
          onClose={() => setRevokeTarget(null)}
        >
          {revokeMutation.isError && (
            <InlineAlert tone="danger">{errorMessage(revokeMutation.error)}</InlineAlert>
          )}
          <p>
            Running jobs may be interrupted. Pair the agent again if you want to reconnect this
            device later.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setRevokeTarget(null)}
            >
              Keep device
            </button>
            <button
              className="button danger"
              type="button"
              disabled={revokeMutation.isPending}
              onClick={() => revokeMutation.mutate(revokeTarget.id)}
            >
              {revokeMutation.isPending ? 'Revoking…' : 'Revoke device'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
