import {
  createMessage,
  serverToClientMessageSchema,
  type ClientToServerMessage,
  type JobStatus,
  type OutputStream,
} from '@relaydock/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { queryKeys } from '../api/queryKeys';
import type { Job, OutputChunk } from '../api/types';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'closed';

interface JobSocketState {
  initialChunks: OutputChunk[];
  subscribeOutput: (sink: (chunk: OutputChunk) => void) => () => void;
  hasOutput: boolean;
  connection: ConnectionState;
  status: JobStatus;
  exitCode: number | null;
  streamError: string | null;
  sendInput: (data: string) => boolean;
  sendResize: (columns: number, rows: number) => boolean;
  sendCancel: () => boolean;
}

function websocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/client`;
}

function uniqueSortedChunks(chunks: OutputChunk[]): OutputChunk[] {
  return [...new Map(chunks.map((chunk) => [chunk.sequence, chunk])).values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
}

interface JobOutputMessage {
  jobId: string;
  sequence: number;
  stream: OutputStream;
  data: string;
}

// job.output is the high-frequency hot path. A full zod parse per chunk is a real
// CPU cost on a busy client (e.g. the laptop that is also running the workload
// and the agent), so validate its shape cheaply here and reserve the schema parse
// for low-frequency control messages. A mismatch returns null and falls through.
function asJobOutput(raw: unknown): JobOutputMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const message = raw as { type?: unknown; payload?: unknown };
  if (
    message.type !== 'job.output' ||
    typeof message.payload !== 'object' ||
    message.payload === null
  ) {
    return null;
  }
  const { jobId, sequence, stream, data } = message.payload as Record<string, unknown>;
  if (
    typeof jobId === 'string' &&
    typeof sequence === 'number' &&
    (stream === 'stdout' || stream === 'stderr') &&
    typeof data === 'string'
  ) {
    return { jobId, sequence, stream, data };
  }
  return null;
}

export function createInputSequenceSeed(nowMilliseconds = Date.now(), entropy?: number): number {
  const randomOffset =
    entropy ??
    (() => {
      const values = new Uint16Array(1);
      globalThis.crypto.getRandomValues(values);
      return values[0] ?? 0;
    })();
  return nowMilliseconds * 1_000 + (randomOffset % 1_000);
}

export function useJobSocket(
  job: Job,
  initialChunks: OutputChunk[],
  enabled = true,
): JobSocketState {
  const queryClient = useQueryClient();
  // Terminal output is a high-frequency stream: a job left running for hours can
  // emit hundreds of thousands of chunks. Holding them in React state made every
  // chunk an O(n) array copy plus a re-render — O(n^2) work and unbounded memory
  // over a long session, which froze the page. Instead we hand each chunk to an
  // imperative sink (the xterm instance, which keeps its own bounded scrollback)
  // and keep only low-frequency status in React state.
  const [initialSortedChunks] = useState(() => uniqueSortedChunks(initialChunks));
  const [hasOutput, setHasOutput] = useState(initialSortedChunks.length > 0);
  const [connection, setConnection] = useState<ConnectionState>(
    navigator.onLine ? 'connecting' : 'offline',
  );
  const [status, setStatus] = useState<JobStatus>(job.status);
  const [exitCode, setExitCode] = useState<number | null>(job.exitCode);
  const [streamError, setStreamError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const terminalRef = useRef(['completed', 'failed', 'cancelled'].includes(job.status));
  // Persistent agent sessions outlive this hook. A time-based seed keeps a
  // newly opened browser's input above sequences acknowledged in an earlier
  // browser session, while the increment preserves ordering within this view.
  const inputSequenceRef = useRef(createInputSequenceSeed());
  const awaitingReplayRef = useRef(false);
  const replayBatchCountRef = useRef(0);
  const latestSizeRef = useRef<{ columns: number; rows: number } | null>(null);
  const hasOutputRef = useRef(initialSortedChunks.length > 0);
  // Output arrives on a single ordered stream and every reconnect resubscribes
  // from lastSequence, so a monotonic high-water mark deduplicates replay without
  // a per-sequence Set that would grow for the whole life of the job.
  const lastSequenceRef = useRef(
    initialSortedChunks.reduce((maximum, chunk) => Math.max(maximum, chunk.sequence), -1),
  );
  const outputSinkRef = useRef<((chunk: OutputChunk) => void) | null>(null);
  const pendingChunksRef = useRef<OutputChunk[]>([]);

  const send = useCallback((message: ClientToServerMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const emitOutput = useCallback((chunk: OutputChunk) => {
    if (!hasOutputRef.current) {
      hasOutputRef.current = true;
      setHasOutput(true);
    }
    const sink = outputSinkRef.current;
    if (sink) sink(chunk);
    // A viewer that has not attached yet (or is mid-reconnect) buffers here so
    // no output is dropped; the buffer drains the moment a sink subscribes.
    else pendingChunksRef.current.push(chunk);
  }, []);

  const subscribeOutput = useCallback((sink: (chunk: OutputChunk) => void) => {
    outputSinkRef.current = sink;
    if (pendingChunksRef.current.length > 0) {
      const pending = pendingChunksRef.current;
      pendingChunksRef.current = [];
      for (const chunk of pending) sink(chunk);
    }
    return () => {
      if (outputSinkRef.current === sink) outputSinkRef.current = null;
    };
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      const inputSequence = inputSequenceRef.current++;
      return send(createMessage('job.input', { jobId: job.id, inputSequence, data }));
    },
    [job.id, send],
  );

  const sendResize = useCallback(
    (columns: number, rows: number) => {
      latestSizeRef.current = { columns, rows };
      return send(createMessage('job.resize', { jobId: job.id, columns, rows }));
    },
    [job.id, send],
  );

  const sendCancel = useCallback(
    () => send(createMessage('job.cancel', { jobId: job.id })),
    [job.id, send],
  );

  useEffect(() => {
    let disposed = false;
    terminalRef.current = ['completed', 'failed', 'cancelled'].includes(job.status);
    setStatus(job.status);
    setExitCode(job.exitCode);
    let connect: () => void;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || terminalRef.current || !enabled) return;
      if (!navigator.onLine) {
        setConnection('offline');
        return;
      }
      setConnection('reconnecting');
      const attempt = reconnectAttemptRef.current++;
      const baseDelay = Math.min(15_000, 500 * 2 ** attempt);
      const delay = baseDelay + Math.round(Math.random() * Math.min(baseDelay * 0.25, 1_000));
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };

    connect = () => {
      if (disposed || terminalRef.current || !enabled || !navigator.onLine) {
        if (!navigator.onLine) setConnection('offline');
        return;
      }
      setConnection(reconnectAttemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const socket = new WebSocket(websocketUrl());
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          socket.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnection('connected');
        setStreamError(null);
        awaitingReplayRef.current = true;
        replayBatchCountRef.current = 0;
        socket.send(
          JSON.stringify(
            createMessage('job.subscribe', {
              jobId: job.id,
              afterSequence: lastSequenceRef.current,
            }),
          ),
        );
        const size = latestSizeRef.current;
        if (size) {
          socket.send(
            JSON.stringify(
              createMessage('job.resize', {
                jobId: job.id,
                columns: size.columns,
                rows: size.rows,
              }),
            ),
          );
        }
      };

      socket.onmessage = (event) => {
        if (disposed) return;
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }

        // Hot path: shape-validate job.output without the full schema parse.
        const output = asJobOutput(raw);
        if (output !== null) {
          if (output.jobId !== job.id) return;
          if (output.sequence <= lastSequenceRef.current) return;
          lastSequenceRef.current = output.sequence;
          if (awaitingReplayRef.current) replayBatchCountRef.current += 1;
          emitOutput({ sequence: output.sequence, stream: output.stream, data: output.data });
          return;
        }

        const parsed = serverToClientMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === 'device.status' || message.payload.jobId !== job.id) return;

        if (message.type === 'job.output') {
          const { sequence, stream, data } = message.payload;
          if (sequence <= lastSequenceRef.current) return;
          lastSequenceRef.current = sequence;
          if (awaitingReplayRef.current) replayBatchCountRef.current += 1;
          emitOutput({ sequence, stream, data });
          return;
        }

        if (message.type === 'job.status') {
          const replayHasMore = awaitingReplayRef.current && replayBatchCountRef.current >= 1_000;
          awaitingReplayRef.current = replayHasMore;
          replayBatchCountRef.current = 0;
          setStatus(message.payload.status);
          if (message.payload.exitCode !== undefined) setExitCode(message.payload.exitCode);
          queryClient.setQueryData<Job>(queryKeys.job(job.id), (current) =>
            current
              ? {
                  ...current,
                  status: message.payload.status,
                  exitCode: message.payload.exitCode ?? current.exitCode,
                }
              : current,
          );
          if (replayHasMore) {
            socket.send(
              JSON.stringify(
                createMessage('job.subscribe', {
                  jobId: job.id,
                  afterSequence: lastSequenceRef.current,
                }),
              ),
            );
            return;
          }
          if (['completed', 'failed', 'cancelled'].includes(message.payload.status)) {
            terminalRef.current = true;
            setConnection('closed');
            void queryClient.invalidateQueries({ queryKey: queryKeys.job(job.id) });
            const closeFinishedSocket = () => {
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify(createMessage('job.unsubscribe', { jobId: job.id })));
              socket.close(1000, 'Job finished');
            };
            if (message.payload.status === 'cancelled') closeFinishedSocket();
            else window.setTimeout(closeFinishedSocket, 250);
          }
          return;
        }

        if (message.type === 'job.completed') {
          terminalRef.current = true;
          setStatus('completed');
          setExitCode(message.payload.exitCode);
          setConnection('closed');
          socket.send(JSON.stringify(createMessage('job.unsubscribe', { jobId: job.id })));
          socket.close(1000, 'Job complete');
          void queryClient.invalidateQueries({ queryKey: queryKeys.job(job.id) });
          return;
        }

        if (message.type === 'job.failed') {
          terminalRef.current = true;
          setStatus('failed');
          setExitCode(message.payload.exitCode ?? null);
          setStreamError(message.payload.error);
          setConnection('closed');
          socket.close(1000, 'Job failed');
          void queryClient.invalidateQueries({ queryKey: queryKeys.job(job.id) });
          return;
        }
        message satisfies never;
      };

      socket.onerror = () => {
        if (disposed) return;
        setStreamError('The live stream was interrupted. RelayDock will keep trying to reconnect.');
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (disposed || terminalRef.current) {
          setConnection('closed');
          return;
        }
        scheduleReconnect();
      };
    };

    const onOffline = () => {
      clearReconnectTimer();
      setConnection('offline');
      socketRef.current?.close();
    };
    const onOnline = () => {
      if (!terminalRef.current && socketRef.current?.readyState !== WebSocket.OPEN) {
        reconnectAttemptRef.current = 0;
        connect();
      }
    };

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    connect();

    return () => {
      disposed = true;
      clearReconnectTimer();
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createMessage('job.unsubscribe', { jobId: job.id })));
      }
      socket?.close(1000, 'Viewer left');
      socketRef.current = null;
    };
  }, [emitOutput, enabled, job.id, job.status, queryClient]);

  return {
    initialChunks: initialSortedChunks,
    subscribeOutput,
    hasOutput,
    connection,
    status,
    exitCode,
    streamError,
    sendInput,
    sendResize,
    sendCancel,
  };
}
