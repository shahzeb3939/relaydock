import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

export interface KebabMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  ariaLabel?: string;
}

export function KebabMenu({ ariaLabel, items }: { ariaLabel: string; items: KebabMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const focusItem = (index: number) => {
    const count = items.length;
    if (count === 0) return;
    itemRefs.current[((index % count) + count) % count]?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = itemRefs.current.findIndex((element) => element === document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className="kebab" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="button quiet kebab-trigger"
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">⋮</span>
      </button>
      {open && (
        <div
          className="kebab-menu"
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              className={`kebab-item${item.danger ? ' danger-text' : ''}`}
              aria-label={item.ariaLabel ?? item.label}
              onClick={() => {
                item.onSelect();
                close(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
