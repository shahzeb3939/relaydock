// A mobile soft keyboard has no arrow keys and can't reliably emit Enter into
// xterm, so interactive prompts (Claude Code's Yes/No menus, for example) are
// impossible to answer from a phone. These buttons send the raw control
// sequences a TUI reads straight to the PTY, bypassing the keyboard entirely.
export const TERMINAL_KEYS = [
  { label: '↑', title: 'Up arrow', data: '\x1b[A' },
  { label: '↓', title: 'Down arrow', data: '\x1b[B' },
  { label: 'Enter', title: 'Enter', data: '\r' },
  { label: 'Esc', title: 'Escape', data: '\x1b' },
  { label: 'Ctrl C', title: 'Interrupt (Ctrl+C)', data: '\x03' },
] as const;

export function TerminalKeys({
  onKey,
  onFocusKeyboard,
  disabled,
}: {
  onKey: (data: string) => void;
  onFocusKeyboard: () => void;
  disabled: boolean;
}) {
  return (
    <div className="terminal-keys" role="group" aria-label="Terminal input keys">
      <button
        type="button"
        className="terminal-key terminal-key--wide"
        // Keep the terminal focused so tapping a key never dismisses the on-screen
        // keyboard mid-answer; the click handler still runs.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onFocusKeyboard}
        disabled={disabled}
      >
        ⌨ Keyboard
      </button>
      {TERMINAL_KEYS.map((key) => (
        <button
          key={key.title}
          type="button"
          className="terminal-key"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onKey(key.data)}
          disabled={disabled}
          aria-label={key.title}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
