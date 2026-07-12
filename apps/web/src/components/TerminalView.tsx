import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { OutputChunk } from '../api/types';

export function TerminalView({
  chunks,
  interactive,
  inputEnabled,
  onInput,
  onResize,
}: {
  chunks: OutputChunk[];
  interactive: boolean;
  inputEnabled: boolean;
  onInput: (data: string) => void;
  onResize: (columns: number, rows: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedChunkCountRef = useRef(0);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);

  onInputRef.current = onInput;
  onResizeRef.current = onResize;

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
      dataSubscription.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      renderedChunkCountRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.cursorBlink = inputEnabled;
    terminal.options.disableStdin = !inputEnabled;
  }, [inputEnabled]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    for (let index = renderedChunkCountRef.current; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk) terminal.write(chunk.data);
    }
    renderedChunkCountRef.current = chunks.length;
  }, [chunks]);

  return (
    <div className="terminal-wrap">
      <div
        ref={containerRef}
        className="terminal-mount"
        role="log"
        aria-label="Job terminal output"
      />
      {inputEnabled && (
        <button
          className="terminal-keyboard-button"
          type="button"
          onClick={() => terminalRef.current?.focus()}
        >
          Focus keyboard
        </button>
      )}
    </div>
  );
}
