import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { Action } from '../api/types';
import {
  EmptyState,
  ErrorState,
  InlineAlert,
  PageLoader,
  Spinner,
  StatusBadge,
} from '../components/Feedback';
import { JobList } from '../components/JobList';
import { Modal } from '../components/Modal';
import { errorMessage } from '../lib';

function ActionForm({ repositoryId, onClose }: { repositoryId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [interactive, setInteractive] = useState(false);
  const [persistent, setPersistent] = useState(false);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.createAction(repositoryId, {
        name: name.trim(),
        command: command.trim(),
        workingDirectory: workingDirectory.trim(),
        interactive,
        persistent,
        confirmationRequired,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.actions(repositoryId) });
      onClose();
    },
  });

  return (
    <Modal
      title="Create an action"
      description="Save a reviewed command as a large, repeatable button."
      onClose={onClose}
      wide
    >
      {mutation.isError && <InlineAlert tone="danger">{errorMessage(mutation.error)}</InlineAlert>}
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <div className="form-grid two-columns">
          <label>
            Action name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Continue with Codex"
              required
              autoFocus
            />
          </label>
          <label>
            Working directory <span className="optional">Optional, relative</span>
            <input
              className="code-input"
              value={workingDirectory}
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="."
            />
          </label>
        </div>
        <label>
          Command
          <input
            className="code-input"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="codex"
            spellCheck={false}
            required
          />
        </label>
        <div className="choice-grid">
          <label className="check-card">
            <input
              type="checkbox"
              checked={interactive}
              onChange={(event) => setInteractive(event.target.checked)}
            />
            <span>
              <strong>Interactive terminal</strong>
              <small>Accept keyboard input and terminal resizing.</small>
            </span>
          </label>
          <label className="check-card">
            <input
              type="checkbox"
              checked={persistent}
              onChange={(event) => setPersistent(event.target.checked)}
            />
            <span>
              <strong>Persistent session</strong>
              <small>Keep running while the browser is away.</small>
            </span>
          </label>
          <label className="check-card">
            <input
              type="checkbox"
              checked={confirmationRequired}
              onChange={(event) => setConfirmationRequired(event.target.checked)}
            />
            <span>
              <strong>Require confirmation</strong>
              <small>Show the exact command before every run.</small>
            </span>
          </label>
        </div>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Spinner />}
            {mutation.isPending ? 'Saving action…' : 'Create action'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CustomCommandForm({ repositoryId, canRun }: { repositoryId: string; canRun: boolean }) {
  const navigate = useNavigate();
  const [command, setCommand] = useState('');
  const [interactive, setInteractive] = useState(true);
  const [persistent, setPersistent] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useMutation({
    mutationFn: () =>
      api.runCustomCommand(repositoryId, { command: command.trim(), interactive, persistent }),
    onSuccess: (job) => navigate(`/jobs/${job.id}`),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed || !command.trim()) return;
    mutation.mutate();
  };

  return (
    <div className="custom-command-panel">
      <InlineAlert tone="warning">
        <strong>Privileged operation.</strong> This command runs through the repository shell with
        the same permissions as the agent user. Review it carefully; RelayDock never adds{' '}
        <code>sudo</code>.
      </InlineAlert>
      {mutation.isError && <InlineAlert tone="danger">{errorMessage(mutation.error)}</InlineAlert>}
      <form className="form-stack" onSubmit={submit}>
        <label>
          Exact command
          <textarea
            className="command-textarea"
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setConfirmed(false);
            }}
            placeholder="git status"
            spellCheck={false}
            rows={3}
            required
          />
        </label>
        <div className="inline-options">
          <label>
            <input
              type="checkbox"
              checked={interactive}
              onChange={(event) => setInteractive(event.target.checked)}
            />{' '}
            Interactive
          </label>
          <label>
            <input
              type="checkbox"
              checked={persistent}
              onChange={(event) => setPersistent(event.target.checked)}
            />{' '}
            Persistent
          </label>
        </div>
        <div className="command-preview">
          <span>Will execute</span>
          <code>{command.trim() || 'Enter a command above'}</code>
        </div>
        <label className="danger-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>I reviewed this exact command and understand it can modify files or data.</span>
        </label>
        <button
          className="button warning full-width"
          type="submit"
          disabled={!canRun || !confirmed || !command.trim() || mutation.isPending}
        >
          {mutation.isPending && <Spinner />}
          {mutation.isPending ? 'Dispatching command…' : 'Run custom command'}
        </button>
      </form>
    </div>
  );
}

export function RepositoryPage() {
  const { repositoryId = '' } = useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [actionFormOpen, setActionFormOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<Action | null>(null);
  const [deleteAction, setDeleteAction] = useState<Action | null>(null);
  const repositoryQuery = useQuery({
    queryKey: queryKeys.repository(repositoryId),
    queryFn: () => api.repository(repositoryId),
    enabled: Boolean(repositoryId),
  });
  const deviceId = repositoryQuery.data?.deviceId ?? '';
  const deviceQuery = useQuery({
    queryKey: queryKeys.device(deviceId),
    queryFn: () => api.device(deviceId),
    enabled: Boolean(deviceId),
    refetchInterval: 15_000,
  });
  const actionsQuery = useQuery({
    queryKey: queryKeys.actions(repositoryId),
    queryFn: () => api.actions(repositoryId),
    enabled: Boolean(repositoryId),
  });
  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs({ repositoryId }),
    queryFn: () => api.jobs({ repositoryId }),
    enabled: Boolean(repositoryId),
    refetchInterval: 10_000,
  });
  const runMutation = useMutation({
    mutationFn: ({ action, confirmed }: { action: Action; confirmed: boolean }) =>
      api.runAction(repositoryId, action.id, confirmed),
    onSuccess: (job) => navigate(`/jobs/${job.id}`),
  });
  const updateMutation = useMutation({
    mutationFn: (allowCustomCommands: boolean) =>
      api.updateRepository(repositoryId, { allowCustomCommands }),
    onSuccess: (repository) =>
      queryClient.setQueryData(queryKeys.repository(repositoryId), repository),
  });
  const deleteMutation = useMutation({
    mutationFn: (actionId: string) => api.deleteAction(actionId),
    onSuccess: async () => {
      setDeleteAction(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.actions(repositoryId) });
    },
  });

  if (repositoryQuery.isPending || actionsQuery.isPending || jobsQuery.isPending)
    return <PageLoader label="Opening repository…" />;
  if (repositoryQuery.isError)
    return (
      <ErrorState
        title="Repository unavailable"
        message={errorMessage(repositoryQuery.error)}
        onRetry={() => void repositoryQuery.refetch()}
      />
    );
  if (actionsQuery.isError)
    return (
      <ErrorState
        message={errorMessage(actionsQuery.error)}
        onRetry={() => void actionsQuery.refetch()}
      />
    );
  if (jobsQuery.isError)
    return (
      <ErrorState
        message={errorMessage(jobsQuery.error)}
        onRetry={() => void jobsQuery.refetch()}
      />
    );

  const repository = repositoryQuery.data;
  const actions = actionsQuery.data;
  const device = deviceQuery.data?.device ?? repository.device;
  const canRun = repository.enabled && device?.status === 'online';

  const startAction = (action: Action) => {
    if (action.confirmationRequired) setConfirmAction(action);
    else runMutation.mutate({ action, confirmed: false });
  };

  return (
    <div className="page repository-page">
      <Link className="back-link" to={`/devices/${repository.deviceId}`}>
        ← {device?.name ?? 'Device'}
      </Link>
      <header className="repository-hero">
        <div className="repo-icon large" aria-hidden="true">
          R
        </div>
        <div className="detail-title">
          <div className="title-line">
            <h1>{repository.name}</h1>
            <StatusBadge
              status={
                canRun ? 'ready' : repository.enabled ? (device?.status ?? 'offline') : 'disabled'
              }
            />
          </div>
          {repository.description && <p>{repository.description}</p>}
          <div className="repo-path">
            <code>{repository.absolutePath}</code>
            {repository.branch && <span className="branch-chip">{repository.branch}</span>}
          </div>
        </div>
      </header>

      {!canRun && (
        <InlineAlert tone="warning">
          {!repository.enabled ? 'This repository is disabled.' : 'The device agent is offline.'}{' '}
          You can review configuration and history, but cannot start a job right now.
        </InlineAlert>
      )}

      <section className="section-block actions-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">QUICK START</span>
            <h2>Actions</h2>
            <p>Reviewed commands for this repository.</p>
          </div>
          <button
            className="button secondary"
            type="button"
            onClick={() => setActionFormOpen(true)}
          >
            <span aria-hidden="true">+</span> New action
          </button>
        </div>
        {runMutation.isError && (
          <InlineAlert tone="danger">{errorMessage(runMutation.error)}</InlineAlert>
        )}
        {actions.length === 0 ? (
          <EmptyState
            icon="▶"
            title="No actions yet"
            message="Save trusted commands like codex, tests, or git status as one-tap actions."
            action={
              <button
                className="button primary"
                type="button"
                onClick={() => setActionFormOpen(true)}
              >
                Create your first action
              </button>
            }
          />
        ) : (
          <div className="action-grid">
            {actions.map((action) => (
              <article className="action-card" key={action.id}>
                <button
                  className="action-run"
                  type="button"
                  disabled={!canRun || runMutation.isPending}
                  onClick={() => startAction(action)}
                >
                  <span className="action-play" aria-hidden="true">
                    ▶
                  </span>
                  <span>
                    <strong>{action.name}</strong>
                    <code>{action.command}</code>
                  </span>
                  <span className="row-arrow" aria-hidden="true">
                    ›
                  </span>
                </button>
                <div className="action-flags">
                  {action.interactive && <span>Interactive</span>}
                  {action.persistent && <span>Persistent</span>}
                  {action.confirmationRequired && <span>Confirms</span>}
                  <button
                    type="button"
                    onClick={() => setDeleteAction(action)}
                    aria-label={`Delete ${action.name}`}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="section-block custom-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ADVANCED</span>
            <h2>Custom command</h2>
            <p>Arbitrary commands are privileged and disabled by default.</p>
          </div>
          <label className="switch-row compact">
            <span>{repository.allowCustomCommands ? 'Enabled' : 'Disabled'}</span>
            <input
              type="checkbox"
              checked={repository.allowCustomCommands}
              disabled={updateMutation.isPending}
              onChange={(event) => updateMutation.mutate(event.target.checked)}
            />
          </label>
        </div>
        {updateMutation.isError && (
          <InlineAlert tone="danger">{errorMessage(updateMutation.error)}</InlineAlert>
        )}
        {repository.allowCustomCommands ? (
          <CustomCommandForm repositoryId={repository.id} canRun={canRun} />
        ) : (
          <div className="custom-disabled">
            <span aria-hidden="true">!</span>
            <div>
              <strong>Custom commands are off</strong>
              <p>
                Use predefined actions for a smaller, auditable command surface. Enable this only
                when you need arbitrary shell syntax.
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ACTIVITY</span>
            <h2>Recent history</h2>
          </div>
          <Link className="text-link" to={`/history?repositoryId=${repository.id}`}>
            View all →
          </Link>
        </div>
        <JobList jobs={jobsQuery.data.slice(0, 8)} compact />
      </section>

      {actionFormOpen && (
        <ActionForm repositoryId={repository.id} onClose={() => setActionFormOpen(false)} />
      )}
      {confirmAction && (
        <Modal
          title={`Run ${confirmAction.name}?`}
          description="Review the exact command before it is dispatched."
          onClose={() => setConfirmAction(null)}
        >
          <div className="command-preview">
            <span>Will execute</span>
            <code>{confirmAction.command}</code>
          </div>
          <p>
            This runs on <strong>{device?.name}</strong> inside <strong>{repository.name}</strong>.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setConfirmAction(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              type="button"
              disabled={runMutation.isPending}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                runMutation.mutate({ action, confirmed: true });
              }}
            >
              Run action
            </button>
          </div>
        </Modal>
      )}
      {deleteAction && (
        <Modal
          title={`Delete ${deleteAction.name}?`}
          description="Existing job history will be retained."
          onClose={() => setDeleteAction(null)}
        >
          {deleteMutation.isError && (
            <InlineAlert tone="danger">{errorMessage(deleteMutation.error)}</InlineAlert>
          )}
          <div className="modal-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setDeleteAction(null)}
            >
              Keep action
            </button>
            <button
              className="button danger"
              type="button"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate(deleteAction.id)}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete action'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
