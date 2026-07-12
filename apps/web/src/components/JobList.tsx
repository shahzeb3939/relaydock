import { Link } from 'react-router-dom';
import type { Job } from '../api/types';
import { formatDuration, formatRelativeTime } from '../lib';
import { EmptyState, StatusBadge } from './Feedback';

export function JobList({ jobs, compact = false }: { jobs: Job[]; compact?: boolean }) {
  if (jobs.length === 0) {
    return (
      <EmptyState
        icon="›_"
        title="No jobs yet"
        message="Commands you run will appear here with their output and status."
      />
    );
  }

  return (
    <div className={`job-list${compact ? ' compact' : ''}`}>
      {jobs.map((job) => (
        <Link className="job-row" to={`/jobs/${job.id}`} key={job.id}>
          <div className="job-command">
            <span className="terminal-prompt" aria-hidden="true">
              $
            </span>
            <div>
              <strong>{job.command}</strong>
              <small>
                {job.repository?.name ?? 'Repository'} · {job.device?.name ?? 'Device'}
              </small>
            </div>
          </div>
          <div className="job-meta">
            <StatusBadge status={job.status} />
            <span>{formatRelativeTime(job.startedAt ?? job.createdAt)}</span>
            {!compact && <span>{formatDuration(job.startedAt, job.finishedAt)}</span>}
            {!compact && job.exitCode !== null && <span>Exit {job.exitCode}</span>}
            <span className="row-arrow" aria-hidden="true">
              ›
            </span>
          </div>
        </Link>
      ))}
    </div>
  );
}
