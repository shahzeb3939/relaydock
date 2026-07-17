import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
    refetchInterval: 30_000,
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
  const [fullscreen, setFullscreen] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  // The input keys stay mounted for the whole interactive-and-running window, so
  // a brief reconnect no longer makes them vanish; `acceptsInput` only decides
  // whether they can send right now.
  const showControls =
    job.interactive && ['running', 'waiting_for_input'].includes(socket.status);
  const acceptsInput = showControls && socket.connection === 'connected';
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!socket.sendCancel()) await api.cancelJob(job.id);
    },
    onSuccess: () => {
      setCancelOpen(false);
      onRefresh();
    },
  });

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      // xterm captures Escape in the capture phase when the terminal is focused
      // (it sends it to the PTY), so this only fires when focus is on the toolbar
      // or key bar — exactly where exiting fullscreen makes sense.
      if (event.key === 'Escape') {
        setFullscreen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      // Trap Tab inside the fullscreen card so focus can't land on page controls
      // (e.g. the Cancel job button) hidden behind the opaque overlay.
      const focusable = [
        ...(cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fullscreen]);

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

      <section
        ref={cardRef}
        className={`terminal-card${fullscreen ? ' terminal-card--fullscreen' : ''}`}
        aria-label="Terminal session"
      >
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
          <button
            type="button"
            className="terminal-tool-button"
            onClick={() => setFullscreen((value) => !value)}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen terminal'}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen terminal'}
          >
            {fullscreen ? '✕' : '⤢'}
          </button>
        </header>
        <TerminalView
          initialChunks={socket.initialChunks}
          subscribeOutput={socket.subscribeOutput}
          interactive={job.interactive}
          inputEnabled={acceptsInput}
          showControls={showControls}
          onInput={(data) => {
            socket.sendInput(data);
          }}
          onResize={(columns, rows) => {
            if (active) socket.sendResize(columns, rows);
          }}
        />
        {!socket.hasOutput && (
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
