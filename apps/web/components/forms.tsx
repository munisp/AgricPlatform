import { cloneElement, isValidElement } from 'react';
import type { ReactElement, ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Field({
  id,
  label,
  hint,
  children
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  // Wire the hint to the control: the hint element has an id but nothing
  // referenced it — inject aria-describedby onto a single element child
  // unless the caller already set one explicitly.
  const control =
    hint && isValidElement(children)
      ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, {
          'aria-describedby':
            (children.props as { 'aria-describedby'?: string })['aria-describedby'] ?? `${id}-hint`
        })
      : children;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {control}
      {hint ? (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="select" {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className="textarea" {...props} />;
}

export function CheckRow({
  id,
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="check-row" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="label" style={{ display: 'block' }}>
          {label}
        </span>
        {description ? <span className="hint">{description}</span> : null}
      </span>
    </label>
  );
}

/** Messaging shown after an offline-friendly (queued) form submission. */
export function QueuedNotice({ label }: { label: string }) {
  return (
    <div className="notice" role="status">
      <strong>Saved offline.</strong> {label} is queued on this device and will sync automatically when
      you are back online.
    </div>
  );
}

/**
 * Subtle "draft restored" indicator (IndexedDB form persistence). Rendered
 * above a form when a stored draft was reloaded on mount.
 */
export function DraftRestoredNotice({ onDismiss }: { onDismiss?: () => void }) {
  return (
    <p className="notice notice-info" role="status" data-testid="draft-restored">
      Draft restored from this device.
      {onDismiss ? (
        <>
          {' '}
          <button type="button" className="btn btn-ghost btn-small" onClick={onDismiss}>
            Discard draft
          </button>
        </>
      ) : null}
    </p>
  );
}
