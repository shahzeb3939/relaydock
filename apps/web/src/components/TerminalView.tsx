import { CanvasAddon } from '@xterm/addon-canvas';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { OutputChunk } from '../api/types';
import { scrollToCursorKeys } from '../lib/terminalScroll';
import { TerminalKeys } from './TerminalKeys';

export function TerminalView({
  initialChunks,
  subscribeOutput,
  interactive,
  inputEnabled,
  showControls,
  onInput,
  onResize,
}: {
  initialChunks: OutputChunk[];
  subscribeOutput: (sink: (chunk: OutputChunk) => void) => () => void;
  interactive: boolean;
  inputEnabled: boolean;
  showControls: boolean;
  onInput: (data: string) => void;
  onResize: (columns: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const initialChunksRef = useRef(initialChunks);
  const subscribeOutputRef = useRef(subscribeOutput);
  const inputEnabledRef = useRef(inputEnabled);

  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  initialChunksRef.current = initialChunks;
  subscribeOutputRef.current = subscribeOutput;
  inputEnabledRef.current = inputEnabled;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: !interactive,
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      fontFamily: "'SFMono-Regular', 'Cascadia Code', 'Liberation Mono', monospace",
      fontSize: 13,
      lineHeight: 1.35,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: {
        background: '#050908',
        foreground: '#d7e5df',
        cursor: '#79f2c0',
        selectionBackground: '#2a5a49',
        black: '#07110f',
        red: '#ff7f87',
        green: '#79f2c0',
        yellow: '#ffcc80',
        blue: '#7ab8ff',
        magenta: '#d8a6ff',
        cyan: '#70e5e1',
        white: '#e8f0ed',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;

    // xterm's default DOM renderer repaints every row on each scroll frame —
    // smooth on a laptop, janky on a phone. The canvas renderer paints rows to
    // a single <canvas>, eliminating the per-row reflow that makes mobile
    // scrolling lag. Fall back to the DOM renderer if the addon can't activate.
    try {
      terminal.loadAddon(new CanvasAddon());
    } catch {
      // Canvas unavailable (very old browser); the DOM renderer still works.
    }

    // A fullscreen TUI runs in the alternate screen buffer, which has no
    // scrollback: a laptop mouse wheel is translated into cursor keys to move the
    // app's selection, but a touch swipe emits no wheel events, so a phone can
    // neither scroll nor navigate. Track the buffer and, while it's the alternate
    // one, turn vertical swipes into the same cursor-key presses. The normal
    // buffer keeps xterm's native scroll untouched.
    let altActive = terminal.buffer.active.type === 'alternate';
    const bufferSubscription = terminal.buffer.onBufferChange(() => {
      altActive = terminal.buffer.active.type === 'alternate';
    });
    let lastTouchY: number | null = null;
    let carriedPx = 0;
    const onTouchStart = (event: TouchEvent) => {
      // Only single-finger drags in the alternate buffer, and only when input can
      // actually reach the PTY; otherwise leave the touch to its default handling.
      const touch = event.touches[0];
      if (!altActive || !inputEnabledRef.current || event.touches.length !== 1 || !touch) {
        lastTouchY = null;
        return;
      }
      lastTouchY = touch.clientY;
      carriedPx = 0;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (lastTouchY === null || event.touches.length !== 1 || !touch) return;
      // We're driving the TUI, not the page — stop native scroll/rubber-banding.
      event.preventDefault();
      const currentY = touch.clientY;
      carriedPx += lastTouchY - currentY; // upward drag is positive
      lastTouchY = currentY;
      const rowHeightPx = element.clientHeight / Math.max(terminal.rows, 1);
      const { data, remainderPx } = scrollToCursorKeys(carriedPx, rowHeightPx);
      if (data) {
        onInputRef.current(data);
        carriedPx = remainderPx;
      }
    };
    const endTouch = () => {
      lastTouchY = null;
      carriedPx = 0;
    };
    element.addEventListener('touchstart', onTouchStart, { passive: true });
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', endTouch, { passive: true });
    element.addEventListener('touchcancel', endTouch, { passive: true });

    // Paint retained output once, then stream every subsequent chunk straight
    // into xterm. xterm buffers and renders writes on its own frame loop and
    // caps history at `scrollback`, so this stays O(1) per chunk and bounded in
    // memory no matter how long the job runs.
    for (const chunk of initialChunksRef.current) terminal.write(chunk.data);
    const unsubscribe = subscribeOutputRef.current((chunk) => {
      terminalRef.current?.write(chunk.data);
    });

    const fitAndReport = () => {
      try {
        fit.fit();
        onResizeRef.current(terminal.cols, terminal.rows);
      } catch {
        // The terminal may be between layout and unmount during a route change.
      }
    };
    const resizeObserver = new ResizeObserver(fitAndReport);
    resizeObserver.observe(element);
    const dataSubscription = terminal.onData((data) => onInputRef.current(data));

    const timer = window.setTimeout(fitAndReport, 0);

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
      dataSubscription.dispose();
      bufferSubscription.dispose();
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', endTouch);
      element.removeEventListener('touchcancel', endTouch);
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = inputEnabled;
    terminal.options.disableStdin = !inputEnabled;
  }, [inputEnabled]);

  const sendKey = (data: string) => {
    onInputRef.current(data);
    // Jump to the newest output so the key's effect is visible even if the user
    // had scrolled up into the history.
    terminalRef.current?.scrollToBottom();
  };

  return (
    <div className="terminal-region">
      <div className="terminal-wrap">
        <div
          ref={containerRef}
          className="terminal-mount"
          role="log"
          aria-label="Job terminal output"
        />
      </div>
      {showControls && (
        <TerminalKeys
          onKey={sendKey}
          onFocusKeyboard={() => terminalRef.current?.focus()}
          disabled={!inputEnabled}
        />
      )}
    </div>
  );
}
