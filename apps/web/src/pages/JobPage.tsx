import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { ErrorState, InlineAlert, PageLoader, Spinner, StatusBadge } from '../components/Feedback';
import { Modal } from '../components/Modal';
import { TerminalView } from '../components/TerminalView';
import { useJobSocket, type ConnectionState } from '../hooks/useJobSocket';
import { errorMessage, formatDateTime, formatDuration, isJobActive } from '../lib';

function ConnectionBadge({
  connection,
  terminal,
}: {
  connection: ConnectionState;
  terminal: boolean;
}) {
  if (terminal)
    return (
      <span className="connection-state closed">
        <span /> Retained output
      </span>
    );
  const label =
    connection === 'connected'
      ? 'Live'
      : connection === 'offline'
        ? 'Offline'
        : connection === 'closed'
          ? 'Closed'
          : connection === 'connecting'
            ? 'Connecting'
            : 'Reconnecting';
  return (
    <span className={`connection-state ${connection}`}>
      <span /> {label}
    </span>
  );
}

function JobConsole({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const jobQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => api.job(jobId),
    refetchInterval: 15_000,
  });
  const outputQuery = useQuery({
    queryKey: queryKeys.output(jobId),
    queryFn: () => api.output(jobId),
    staleTime: Infinity,
  });

  if (jobQuery.isPending || outputQuery.isPending)
    return <PageLoader label="Restoring terminal output…" />;
  if (jobQuery.isError)
    return (
      <ErrorState
        title="Job unavailable"
        message={errorMessage(jobQuery.error)}
        onRetry={() => void jobQuery.refetch()}
      />
    );
  if (outputQuery.isError)
    return (
      <ErrorState
        title="Output unavailable"
        message={errorMessage(outputQuery.error)}
        onRetry={() => void outputQuery.refetch()}
      />
    );

  return (
    <ConnectedJobConsole
      key={jobQuery.data.id}
      job={jobQuery.data}
      initialChunks={outputQuery.data}
      cancelOpen={cancelOpen}
      setCancelOpen={setCancelOpen}
      onRefresh={() =>
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.output(jobId) }),
        ])
      }
    />
  );
}

function ConnectedJobConsole({
  job,
  initialChunks,
  cancelOpen,
  setCancelOpen,
  onRefresh,
}: {
  job: Awaited<ReturnType<typeof api.job>>;
  initialChunks: Awaited<ReturnType<typeof api.output>>;
  cancelOpen: boolean;
  setCancelOpen: (open: boolean) => void;
  onRefresh: () => void;
}) {
  const socket = useJobSocket(job, initialChunks, isJobActive(job.status));
  const active = isJobActive(socket.status);
  const terminal = !active;
  const acceptsInput =
    job.interactive &&
    ['running', 'waiting_for_input'].includes(socket.status) &&
    socket.connection === 'connected';
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!socket.sendCancel()) await api.cancelJob(job.id);
    },
    onSuccess: () => {
      setCancelOpen(false);
      onRefresh();
    },
  });

  return (
    <div className="page job-page">
      <Link className="back-link" to={`/repositories/${job.repositoryId}`}>
        ← {job.repository?.name ?? 'Repository'}
      </Link>
      <header className="job-header">
        <div className="job-heading-copy">
          <div className="title-line">
            <h1>{job.command}</h1>
            <StatusBadge status={socket.status} />
          </div>
          <p>
            {job.repository?.name ?? 'Repository'} · {job.device?.name ?? 'Device'}
          </p>
        </div>
        <div className="job-header-actions">
          <ConnectionBadge connection={socket.connection} terminal={terminal} />
          {active && (
            <button
              className="button danger subtle"
              type="button"
              onClick={() => setCancelOpen(true)}
            >
              Cancel job
            </button>
          )}
        </div>
      </header>

      {(socket.connection === 'reconnecting' || socket.connection === 'offline') && active && (
        <InlineAlert tone="warning">
          {socket.connection === 'offline'
            ? 'Your browser is offline.'
            : 'The live connection was interrupted.'}{' '}
          The process continues on the agent; missing output will replay after reconnection.
        </InlineAlert>
      )}
      {socket.streamError && socket.connection !== 'connected' && (
        <InlineAlert tone="danger">{socket.streamError}</InlineAlert>
      )}

      <section className="terminal-card" aria-label="Terminal session">
        <header className="terminal-toolbar">
          <div className="terminal-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="terminal-title">
            {job.repository?.name ?? 'repository'} — {job.id.slice(0, 8)}
          </span>
          <ConnectionBadge connection={socket.connection} terminal={terminal} />
        </header>
        <TerminalView
          chunks={socket.chunks}
          interactive={job.interactive}
          inputEnabled={acceptsInput}
          onInput={(data) => {
            socket.sendInput(data);
          }}
          onResize={(columns, rows) => {
            if (active) socket.sendResize(columns, rows);
          }}
        />
        {socket.chunks.length === 0 && (
          <div className="terminal-empty">
            {active ? (
              <>
                <Spinner /> Waiting for output…
              </>
            ) : (
              'No output was retained for this job.'
            )}
          </div>
        )}
      </section>

      <dl className="job-facts">
        <div>
          <dt>Started</dt>
          <dd>{formatDateTime(job.startedAt ?? job.createdAt)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{formatDuration(job.startedAt, job.finishedAt)}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>
            {job.interactive ? 'Interactive' : 'Non-interactive'}
            {job.persistent ? ' · Persistent' : ''}
          </dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{socket.exitCode ?? '—'}</dd>
        </div>
      </dl>

      {cancelOpen && (
        <Modal
          title="Cancel this job?"
          description="RelayDock will ask the agent to terminate the running process."
          onClose={() => setCancelOpen(false)}
        >
          {cancelMutation.isError && (
            <InlineAlert tone="danger">{errorMessage(cancelMutation.error)}</InlineAlert>
          )}
          <div className="command-preview">
            <span>Running command</span>
            <code>{job.command}</code>
          </div>
          <div className="modal-actions">
            <button className="button secondary" type="button" onClick={() => setCancelOpen(false)}>
              Keep running
            </button>
            <button
              className="button danger"
              type="button"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel job'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function JobPage() {
  const { jobId = '' } = useParams();
  return <JobConsole jobId={jobId} />;
}
