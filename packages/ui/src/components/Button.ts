// Button — the one canonical control appearance (no ad-hoc
// button implementations). Consumes tokens only.

import { cx, esc } from '../render/html.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit';
  disabled?: boolean;
  /** Emitted as `data-opsui-action`; the client module turns it into a command. */
  action?: string;
  /** Renders as an anchor with button styling. Mutually exclusive with action. */
  href?: string;
};

export function Button(props: ButtonProps): string {
  const variant: ButtonVariant = props.variant ?? 'secondary';
  const size: ButtonSize = props.size ?? 'md';
  const className = cx(
    'opsui-btn',
    `opsui-btn--${variant}`,
    `opsui-btn--${size}`,
  );
  // Link-shaped actions are Buttons too (no local button styles anywhere else) —
  // an href renders a real anchor carrying the identical classes.
  if (props.href) {
    return `<a class="${className}" href="${esc(props.href)}">${esc(props.label)}</a>`;
  }
  const action = props.action ? ` data-opsui-action="${esc(props.action)}"` : '';
  const disabled = props.disabled ? ' disabled' : '';
  return (
    `<button type="${props.type ?? 'button'}" class="${className}"${action}${disabled}>` +
    `${esc(props.label)}</button>`
  );
}
