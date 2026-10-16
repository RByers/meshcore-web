/**
 * Design tokens (CSS custom properties, light/dark via `light-dark()` + `color-scheme`) and
 * shared component styles. Tokens are declared on `<mc-app>`'s host and inherit into every
 * shadow root below it.
 */
import { css } from 'lit';

export const tokens = css`
  :host {
    color-scheme: light dark;
    --mc-bg: light-dark(#f6f7f9, #111418);
    --mc-surface: light-dark(#ffffff, #1b1f25);
    --mc-surface-2: light-dark(#eef1f5, #242a31);
    --mc-text: light-dark(#14181d, #e7eaee);
    --mc-text-muted: light-dark(#59626e, #a0a9b4);
    --mc-border: light-dark(#d6dbe1, #343b44);
    --mc-accent: light-dark(#0b63c9, #6cb4ff);
    --mc-accent-text: light-dark(#ffffff, #0b1a2b);
    --mc-accent-soft: light-dark(#e3eefb, #1d3550);
    --mc-ok: light-dark(#167a3e, #5ad48a);
    --mc-warn: light-dark(#9a5b00, #f0b44c);
    --mc-danger: light-dark(#b42318, #ff8a80);
    --mc-focus: light-dark(#0b63c9, #8cc4ff);
    --mc-radius: 10px;
    --mc-gap: 16px;
    --mc-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    --mc-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    accent-color: var(--mc-accent);
  }
`;

export const shared = css`
  :host {
    font-family: var(--mc-font);
    color: var(--mc-text);
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  h1,
  h2,
  h3 {
    margin: 0 0 0.5em;
    line-height: 1.2;
  }
  p {
    margin: 0 0 0.75em;
  }
  a {
    color: var(--mc-accent);
  }
  :focus-visible {
    outline: 2px solid var(--mc-focus);
    outline-offset: 2px;
  }
  button {
    font: inherit;
    cursor: pointer;
    border-radius: 8px;
    border: 1px solid var(--mc-border);
    background: var(--mc-surface);
    color: var(--mc-text);
    padding: 0.5em 1em;
    min-height: 2.5rem;
  }
  button:hover:not(:disabled) {
    background: var(--mc-surface-2);
  }
  button.primary {
    background: var(--mc-accent);
    border-color: var(--mc-accent);
    color: var(--mc-accent-text);
  }
  button.primary:hover:not(:disabled) {
    background: color-mix(in oklab, var(--mc-accent), black 12%);
  }
  button.danger {
    color: var(--mc-danger);
    border-color: color-mix(in oklab, var(--mc-danger), transparent 50%);
  }
  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
  .card {
    background: var(--mc-surface);
    border: 1px solid var(--mc-border);
    border-radius: var(--mc-radius);
    padding: var(--mc-gap);
  }
  .muted {
    color: var(--mc-text-muted);
  }
  .mono {
    font-family: var(--mc-mono);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
`;
