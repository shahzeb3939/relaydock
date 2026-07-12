import { jobStatusSchema } from '@relaydock/protocol';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import type { JobFilters } from '../api/types';
import { ErrorState, PageLoader } from '../components/Feedback';
import { JobList } from '../components/JobList';
import { errorMessage } from '../lib';

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const statusResult = jobStatusSchema.safeParse(searchParams.get('status'));
  const status = statusResult.success ? statusResult.data : '';
  const deviceId = searchParams.get('deviceId') ?? undefined;
  const repositoryId = searchParams.get('repositoryId') ?? undefined;
  const filters: JobFilters = {};
  if (deviceId) filters.deviceId = deviceId;
  if (repositoryId) filters.repositoryId = repositoryId;
  if (status) filters.status = status;

  const jobsQuery = useQuery({
    queryKey: queryKeys.jobs(filters),
    queryFn: () => api.jobs(filters),
    refetchInterval: 15_000,
  });

  if (jobsQuery.isPending) return <PageLoader label="Loading job history…" />;
  if (jobsQuery.isError)
    return (
      <ErrorState
        message={errorMessage(jobsQuery.error)}
        onRetry={() => void jobsQuery.refetch()}
      />
    );

  return (
    <div className="page history-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">AUDIT TRAIL</span>
          <h1>Job history</h1>
          <p>Reopen retained output or reconnect to a running session.</p>
        </div>
        <label className="compact-field">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              const next = new URLSearchParams(searchParams);
              if (event.target.value) next.set('status', event.target.value);
              else next.delete('status');
              setSearchParams(next, { replace: true });
            }}
          >
            <option value="">All statuses</option>
            <option value="running">Running</option>
            <option value="waiting_for_input">Waiting for input</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="disconnected">Disconnected</option>
          </select>
        </label>
      </header>
      {(deviceId || repositoryId) && (
        <div className="filter-banner">
          <span>Filtered history</span>
          <button
            type="button"
            onClick={() => setSearchParams(status ? { status } : {}, { replace: true })}
          >
            Clear source filter
          </button>
        </div>
      )}
      <JobList jobs={jobsQuery.data} />
    </div>
  );
}
