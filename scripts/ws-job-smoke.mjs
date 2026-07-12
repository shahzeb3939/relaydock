import { randomUUID } from 'node:crypto';

import WebSocket from 'ws';

const url = process.env.RELAYDOCK_WS_URL;
const cookie = process.env.RELAYDOCK_COOKIE;
const jobId = process.env.RELAYDOCK_JOB_ID;
const origin = process.env.RELAYDOCK_ORIGIN ?? 'http://localhost:5173';
const input = process.env.RELAYDOCK_STDIN;
const waitFor = process.env.RELAYDOCK_WAIT_FOR;
const expected = process.env.RELAYDOCK_EXPECT;
const inputSequence = Number(process.env.RELAYDOCK_INPUT_SEQUENCE ?? 0);
const closeAfterExpected = process.env.RELAYDOCK_CLOSE_AFTER_EXPECT === 'true';
const timeoutMs = Number(process.env.RELAYDOCK_SMOKE_TIMEOUT_MS ?? 15_000);

if (!url || !cookie || !jobId) {
  throw new Error('RELAYDOCK_WS_URL, RELAYDOCK_COOKIE, and RELAYDOCK_JOB_ID are required.');
}

const message = (type, payload) =>
  JSON.stringify({
    version: 1,
    type,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    payload,
  });

const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: origin } });
let output = '';
let sentInput = false;
let finalStatus = null;
let exitCode = null;

const timeout = setTimeout(() => {
  socket.terminate();
  process.stderr.write(`Timed out. Retained output:\n${output}\n`);
  process.exitCode = 1;
}, timeoutMs);

socket.on('open', () => {
  socket.send(message('job.subscribe', { jobId, afterSequence: -1 }));
  socket.send(message('job.resize', { jobId, columns: 100, rows: 30 }));
});

socket.on('message', (data) => {
  const incoming = JSON.parse(data.toString());
  if (incoming?.payload?.jobId !== jobId) return;
  if (incoming.type === 'job.output') {
    output += incoming.payload.data;
    if (!sentInput && input !== undefined && (waitFor === undefined || output.includes(waitFor))) {
      sentInput = true;
      socket.send(message('job.input', { jobId, inputSequence, data: input }));
    }
    if (closeAfterExpected && expected !== undefined && output.includes(expected)) {
      socket.close(1000, 'Expected output observed');
    }
    return;
  }
  if (incoming.type === 'job.status') {
    finalStatus = incoming.payload.status;
    if (incoming.payload.exitCode !== undefined) exitCode = incoming.payload.exitCode;
  } else if (incoming.type === 'job.completed') {
    finalStatus = 'completed';
    exitCode = incoming.payload.exitCode;
  } else if (incoming.type === 'job.failed') {
    finalStatus = 'failed';
    exitCode = incoming.payload.exitCode ?? null;
  }
  if (['completed', 'failed', 'cancelled'].includes(finalStatus)) socket.close(1000);
});

socket.on('error', (error) => {
  clearTimeout(timeout);
  throw error;
});

socket.on('close', () => {
  clearTimeout(timeout);
  const passed = closeAfterExpected
    ? finalStatus !== 'failed' && expected !== undefined && output.includes(expected)
    : finalStatus === 'completed' &&
      exitCode === 0 &&
      (expected === undefined || output.includes(expected));
  process.stdout.write(`${JSON.stringify({ passed, finalStatus, exitCode, output })}\n`);
  if (!passed) process.exitCode = 1;
});
