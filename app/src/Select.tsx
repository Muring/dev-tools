import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
type Option = { value: string; label: string };
export function Select({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const anchor = useRef({ top: 0, left: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 240 });
  const selected = Math.max(
    0,
    options.findIndex(option => option.value === value),
  );
  function show() {
    if (disabled) return;
    const box = trigger.current!.getBoundingClientRect();
    anchor.current = { top: box.top, left: box.left };
    const below = window.innerHeight - box.bottom - 12;
    const height = Math.min(240, Math.max(below, box.top - 12));
    setPosition({
      top:
        below >= Math.min(240, options.length * 44 + 12)
          ? box.bottom + 6
          : Math.max(8, box.top - Math.min(height, options.length * 44 + 12) - 6),
      left: box.left,
      width: box.width,
      maxHeight: height,
    });
    setActive(selected);
    setOpen(true);
  }
  function choose(index: number) {
    onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node))
        setOpen(false);
    };
    const close = () => setOpen(false);
    // A scroll event queued before the menu opened (e.g. the click scrolling the trigger into view) still arrives now; only close when the trigger actually moved.
    const moved = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (box && (Math.abs(box.top - anchor.current.top) > 1 || Math.abs(box.left - anchor.current.left) > 1))
        setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', moved, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', moved, true);
    };
  }, [open]);
  useEffect(() => {
    if (open) popup.current?.querySelectorAll('[role=option]')[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);
  return (
    <div className="field">
      <span id={id + '-label'}>{label}</span>
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-labelledby={id + '-label'}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? id + '-' + active : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={event => {
          if (!popup.current?.contains(event.relatedTarget as Node)) setOpen(false);
        }}
        onKeyDown={event => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            if (!open) {
              show();
              return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
              choose(active);
              return;
            }
            setActive(
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? options.length - 1
                  : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
            );
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
          if (event.key === 'Tab') setOpen(false);
        }}>
        <span>{options.find(option => option.value === value)?.label || value}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            className="select-menu"
            role="listbox"
            aria-labelledby={id + '-label'}
            style={position}>
            {options.map((option, index) => (
              <div
                id={id + '-' + index}
                role="option"
                aria-selected={option.value === value}
                className={active === index ? 'focused' : ''}
                key={option.value}
                onPointerMove={() => setActive(index)}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(index)}>
                <span>{option.label}</span>
                <span aria-hidden="true">{option.value === value ? '✓' : ''}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
