import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../api/types';
import { createInputSequenceSeed, useJobSocket } from './useJobSocket';

const jobId = '00000000-0000-4000-8000-000000000001';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code: 1000 }));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

const job: Job = {
  id: jobId,
  deviceId: '00000000-0000-4000-8000-000000000002',
  repositoryId: '00000000-0000-4000-8000-000000000003',
  actionId: null,
  command: 'codex',
  workingDirectory: '',
  status: 'running',
  interactive: true,
  persistent: true,
  exitCode: null,
  startedAt: '2026-07-12T10:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-07-12T10:00:00.000Z',
  updatedAt: '2026-07-12T10:00:00.000Z',
};

function message(type: string, payload: object) {
  return {
    version: 1,
    type,
    requestId: '00000000-0000-4000-8000-000000000004',
    timestamp: '2026-07-12T10:00:00.000Z',
    payload,
  };
}

function Probe() {
  const socket = useJobSocket(job, [{ sequence: 7, stream: 'stdout', data: 'retained\n' }], true);
  // Mirror how TerminalView drains output: paint the retained chunks once, then
  // append every streamed chunk delivered through the imperative sink.
  const [output, setOutput] = useState('');
  const { initialChunks, subscribeOutput } = socket;
  useEffect(() => {
    setOutput(initialChunks.map((chunk) => chunk.data).join(''));
    return subscribeOutput((chunk) => setOutput((current) => current + chunk.data));
  }, [initialChunks, subscribeOutput]);
  return (
    <div>
      <span data-testid="connection">{socket.connection}</span>
      <pre data-testid="output">{output}</pre>
      <button type="button" onClick={() => socket.sendInput('y\r')}>
        Input
      </button>
      <button type="button" onClick={() => socket.sendResize(42, 18)}>
        Resize
      </button>
      <button type="button" onClick={() => socket.sendCancel()}>
        Cancel
      </button>
    </div>
  );
}

describe('useJobSocket', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('seeds input above prior browser sessions instead of restarting at zero', () => {
    const priorBrowserSequence = createInputSequenceSeed(1_700_000_000_000, 999);
    const reopenedBrowserSequence = createInputSequenceSeed(1_700_000_000_001, 0);

    expect(priorBrowserSequence).toBe(1_700_000_000_000_999);
    expect(reopenedBrowserSequence).toBeGreaterThan(priorBrowserSequence);
    expect(Number.isSafeInteger(reopenedBrowserSequence)).toBe(true);
  });

  it('subscribes after retained output, deduplicates replay, and sends terminal controls', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );

    const websocket = MockWebSocket.instances[0];
    expect(websocket?.url).toMatch(/\/ws\/client$/);
    act(() => websocket?.open());

    await waitFor(() => expect(screen.getByTestId('connection')).toHaveTextContent('connected'));
    const subscription = JSON.parse(websocket?.sent[0] ?? '{}') as {
      type?: string;
      payload?: { afterSequence?: number };
    };
    expect(subscription).toMatchObject({
      type: 'job.subscribe',
      payload: { afterSequence: 7 },
    });

    act(() => {
      websocket?.receive(
        message('job.output', { jobId, sequence: 7, stream: 'stdout', data: 'duplicate\n' }),
      );
      websocket?.receive(
        message('job.output', { jobId, sequence: 8, stream: 'stdout', data: 'live\n' }),
      );
    });
    expect(screen.getByTestId('output')).toHaveTextContent('retained live');
    expect(screen.getByTestId('output')).not.toHaveTextContent('duplicate');

    fireEvent.click(screen.getByRole('button', { name: 'Input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const sentTypes = websocket?.sent.map((frame) => (JSON.parse(frame) as { type: string }).type);
    expect(sentTypes).toEqual(['job.subscribe', 'job.input', 'job.resize', 'job.cancel']);
    const inputFrame = websocket?.sent
      .map((frame) => JSON.parse(frame) as { type: string; payload: { inputSequence?: number } })
      .find((frame) => frame.type === 'job.input');
    expect(inputFrame?.payload.inputSequence).toBeGreaterThan(1_000_000_000_000);
  });
});
