import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { ErrorState, InlineAlert, PageLoader, Spinner, StatusBadge } from '../components/Feedback';
import { JobList } from '../components/JobList';
import { Modal } from '../components/Modal';
import { errorMessage, formatDateTime, formatRelativeTime } from '../lib';

function RepositoryForm({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [absolutePath, setAbsolutePath] = useState('');
  const [description, setDescription] = useState('');
  const [shell, setShell] = useState('/bin/zsh');
  const [inheritedEnvironment, setInheritedEnvironment] = useState(
    'PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, TERM, LANG',
  );
  const [allowCustomCommands, setAllowCustomCommands] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.createRepository(deviceId, {
        name: name.trim(),
        absolutePath: absolutePath.trim(),
        description: description.trim(),
        shell,
        shellArgs: shell === 'powershell.exe' ? ['-NoLogo', '-NoProfile', '-Command'] : ['-lc'],
        inheritedEnvironment: inheritedEnvironment
          .split(',')
          .map((environmentName) => environmentName.trim())
          .filter(Boolean),
        allowCustomCommands,
      }),
    onSuccess: async (repository) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.device(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.devices }),
      ]);
      navigate(`/repositories/${repository.id}`);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <Modal
      title="Register a repository"
      description="RelayDock asks the online agent to validate this path before saving it."
      onClose={onClose}
      wide
    >
      {mutation.isError && <InlineAlert tone="danger">{errorMessage(mutation.error)}</InlineAlert>}
      <form className="form-stack" onSubmit={submit}>
        <div className="form-grid two-columns">
          <label>
            Repository name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="MVP"
              required
              autoFocus
            />
          </label>
          <label>
            Shell
            <select value={shell} onChange={(event) => setShell(event.target.value)}>
              <option value="/bin/zsh">/bin/zsh</option>
              <option value="/bin/bash">/bin/bash</option>
              <option value="/bin/sh">/bin/sh</option>
              <option value="powershell.exe">PowerShell</option>
            </select>
          </label>
        </div>
        <label>
          Absolute path on this device
          <input
            className="code-input"
            value={absolutePath}
            onChange={(event) => setAbsolutePath(event.target.value)}
            placeholder="/Users/you/projects/mvp"
            spellCheck={false}
            required
          />
          <small>
            Use an existing directory. The agent resolves the canonical path and checks access.
          </small>
        </label>
        <label>
          Inherited environment names
          <input
            className="code-input"
            value={inheritedEnvironment}
            onChange={(event) => setInheritedEnvironment(event.target.value)}
            placeholder="PATH, HOME, USER, SHELL, TERM, LANG"
            spellCheck={false}
          />
          <small>
            Names only, separated by commas. Values stay on the device and are never shown in the
            web app.
          </small>
        </label>
        <label>
          Description <span className="optional">Optional</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this repository is for"
            rows={3}
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>Allow custom commands</strong>
            <small>Disabled by default. Predefined actions are safer.</small>
          </span>
          <input
            type="checkbox"
            checked={allowCustomCommands}
            onChange={(event) => setAllowCustomCommands(event.target.checked)}
          />
        </label>
        {allowCustomCommands && (
          <InlineAlert tone="warning">
            Custom commands can execute arbitrary shell instructions with your agent user’s
            permissions.
          </InlineAlert>
        )}
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {mutation.isPending ? 'Validating path…' : 'Validate and register'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeviceDetailPage() {
  const { deviceId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [repositoryFormOpen, setRepositoryFormOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const deviceQuery = useQuery({
    queryKey: queryKeys.device(deviceId),
    queryFn: () => api.device(deviceId),
    enabled: Boolean(deviceId),
    refetchInterval: 15_000,
  });
  const revokeMutation = useMutation({
    mutationFn: () => api.revokeDevice(deviceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.devices });
      navigate('/devices', { replace: true });
    },
  });

  if (deviceQuery.isPending) return <PageLoader label="Opening device…" />;
  if (deviceQuery.isError) {
    return (
      <ErrorState
        title="Device unavailable"
        message={errorMessage(deviceQuery.error)}
        onRetry={() => void deviceQuery.refetch()}
      />
    );
  }

  const { device, repositories, recentJobs } = deviceQuery.data;

  return (
    <div className="page detail-page">
      <Link className="back-link" to="/devices">
        ← All devices
      </Link>
      <header className="detail-hero">
        <div className={`device-icon large ${device.status}`} aria-hidden="true">
          {device.platform.toLowerCase().includes('darwin') ||
          device.platform.toLowerCase().includes('mac')
            ? 'M'
            : 'PC'}
        </div>
        <div className="detail-title">
          <div className="title-line">
            <h1>{device.name}</h1>
            <StatusBadge status={device.status} />
          </div>
          <p>
            {device.platform} · {device.architecture} · Agent v{device.agentVersion}
          </p>
        </div>
        <button
          className="button quiet danger-text detail-revoke"
          type="button"
          onClick={() => setRevokeOpen(true)}
        >
          Revoke device
        </button>
      </header>

      {device.status !== 'online' && (
        <InlineAlert tone="warning">
          This device was last seen {formatRelativeTime(device.lastSeenAt)}. Connect its agent
          before registering repositories or starting jobs.
        </InlineAlert>
      )}

      <section className="section-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">WORKSPACES</span>
            <h2>Repositories</h2>
          </div>
          <button
            className="button secondary"
            type="button"
            disabled={device.status !== 'online'}
            onClick={() => setRepositoryFormOpen(true)}
          >
            <span aria-hidden="true">+</span> Register repository
          </button>
        </div>
        {repositories.length === 0 ? (
          <div className="inline-empty">
            <div>
              <strong>No repositories registered</strong>
              <p>Add an existing directory from this device to start running actions.</p>
            </div>
            <button
              className="button primary"
              type="button"
              disabled={device.status !== 'online'}
              onClick={() => setRepositoryFormOpen(true)}
            >
              Register repository
            </button>
          </div>
        ) : (
          <div className="repository-list">
            {repositories.map((repository) => (
              <Link
                className="repository-row"
                to={`/repositories/${repository.id}`}
                key={repository.id}
              >
                <span className="repo-icon" aria-hidden="true">
                  R
                </span>
                <div className="repo-copy">
                  <div>
                    <strong>{repository.name}</strong>
                    {repository.branch && <span className="branch-chip">{repository.branch}</span>}
                  </div>
                  <code>{repository.absolutePath}</code>
                </div>
                <span className={`repo-state ${repository.enabled ? 'enabled' : 'disabled'}`}>
                  {repository.enabled ? 'Ready' : 'Disabled'}
                </span>
                <span className="row-arrow" aria-hidden="true">
                  ›
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ACTIVITY</span>
            <h2>Recent jobs</h2>
          </div>
          <Link className="text-link" to={`/history?deviceId=${device.id}`}>
            View all →
          </Link>
        </div>
        <JobList
          jobs={recentJobs.map((job) => ({
            ...job,
            device: { id: device.id, name: device.name },
          }))}
          compact
        />
      </section>

      <section className="section-block metadata-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">DETAILS</span>
            <h2>Device metadata</h2>
          </div>
        </div>
        <dl className="metadata-grid">
          <div>
            <dt>Platform</dt>
            <dd>{device.platform}</dd>
          </div>
          <div>
            <dt>Architecture</dt>
            <dd>{device.architecture}</dd>
          </div>
          <div>
            <dt>Agent version</dt>
            <dd>{device.agentVersion}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{formatDateTime(device.lastSeenAt)}</dd>
          </div>
          <div>
            <dt>Paired</dt>
            <dd>{formatDateTime(device.createdAt)}</dd>
          </div>
          <div>
            <dt>Device ID</dt>
            <dd>
              <code>{device.id}</code>
            </dd>
          </div>
        </dl>
      </section>

      {repositoryFormOpen && (
        <RepositoryForm deviceId={device.id} onClose={() => setRepositoryFormOpen(false)} />
      )}
      {revokeOpen && (
        <Modal
          title={`Revoke ${device.name}?`}
          description="The device credential will stop working immediately."
          onClose={() => setRevokeOpen(false)}
        >
          {revokeMutation.isError && (
            <InlineAlert tone="danger">{errorMessage(revokeMutation.error)}</InlineAlert>
          )}
          <p>Running jobs may be interrupted. This action cannot be undone.</p>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setRevokeOpen(false)}>
              Cancel
            </button>
            <button
              className="button danger"
              type="button"
              disabled={revokeMutation.isPending}
              onClick={() => revokeMutation.mutate()}
            >
              {revokeMutation.isPending ? 'Revoking…' : 'Revoke device'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
