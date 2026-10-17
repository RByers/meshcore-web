/** Shared styles, icons and helpers for the contacts / chat / channels / messages pages. */
import { css, html, nothing, type TemplateResult } from 'lit';
import type { ChannelKind, ContactKind } from '@meshcore-web/core/app';

export const TYPE_ICON: Record<ContactKind | ChannelKind, string> = {
  chat: '👤',
  repeater: '📡',
  room: '🏠',
  sensor: '🌡',
  public: '🌐',
  hashtag: '#',
  private: '🔒',
};

export const TYPE_LABEL: Record<ContactKind | ChannelKind, string> = {
  chat: 'Chat',
  repeater: 'Repeater',
  room: 'Room server',
  sensor: 'Sensor',
  public: 'Public channel',
  hashtag: 'Hashtag channel',
  private: 'Private channel',
};

export function avatar(kind: ContactKind | ChannelKind): TemplateResult {
  return html`<span class="avatar" data-kind=${kind} role="img" aria-label=${TYPE_LABEL[kind]} title=${TYPE_LABEL[kind]}
    >${TYPE_ICON[kind]}</span
  >`;
}

export function unreadBadge(n: number, muted = false): TemplateResult | typeof nothing {
  if (n <= 0) return nothing;
  const label = n > 9999 ? '9999+' : String(n);
  return html`<span class="badge" data-unread=${n} ?data-muted=${muted} aria-label=${`${n} unread`}>${label}</span>`;
}

/** The error message of a thrown value. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copies to the clipboard when allowed; resolves false otherwise. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const listStyles = css`
  :host {
    display: block;
    container-type: inline-size;
  }
  .page-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-block-end: 12px;
  }
  .page-head h2 {
    margin: 0;
    flex: 1;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-block-end: 12px;
  }
  .toolbar input[type='search'] {
    flex: 1 1 12rem;
  }
  input:not([type='checkbox'], [type='radio'], [type='range']),
  select,
  textarea {
    font: inherit;
    color: var(--mc-text);
    background: var(--mc-surface);
    border: 1px solid var(--mc-border);
    border-radius: 8px;
    padding: 0.45em 0.65em;
    min-height: 2.5rem;
  }
  textarea {
    resize: vertical;
  }
  ul.list {
    list-style: none;
    margin: 0;
    padding: 0;
    background: var(--mc-surface);
    border: 1px solid var(--mc-border);
    border-radius: var(--mc-radius);
    overflow: hidden;
  }
  ul.list > li {
    display: flex;
    align-items: center;
    gap: 4px;
    border-block-end: 1px solid var(--mc-border);
  }
  ul.list > li:last-child {
    border-block-end: 0;
  }
  .row-link {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    color: inherit;
    text-decoration: none;
  }
  .row-link:hover {
    background: var(--mc-surface-2);
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-weight: 600;
  }
  .row-title .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-title .when {
    margin-inline-start: auto;
    font-weight: 400;
    font-size: 0.8rem;
    color: var(--mc-text-muted);
    white-space: nowrap;
  }
  .row-sub,
  .preview {
    font-size: 0.85rem;
    color: var(--mc-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .avatar {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 2.4rem;
    height: 2.4rem;
    border-radius: 50%;
    background: var(--mc-accent-soft);
    font-size: 1.1rem;
  }
  .avatar[data-kind='repeater'] {
    background: color-mix(in oklab, #d89a00, transparent 75%);
  }
  .avatar[data-kind='room'] {
    background: color-mix(in oklab, #c2189b, transparent 78%);
  }
  .avatar[data-kind='sensor'] {
    background: color-mix(in oklab, #0f9d8f, transparent 75%);
  }
  .avatar[data-kind='public'] {
    background: color-mix(in oklab, #1e9e4a, transparent 75%);
  }
  .badge {
    flex: none;
    font-size: 0.75rem;
    font-weight: 600;
    min-width: 1.6em;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--mc-accent);
    color: var(--mc-accent-text);
    text-align: center;
  }
  .badge[data-muted] {
    background: var(--mc-surface-2);
    color: var(--mc-text-muted);
  }
  .menu-btn {
    flex: none;
    border: 0;
    background: transparent;
    min-width: 2.5rem;
    margin-inline-end: 4px;
  }
  .menu {
    margin: 0;
    padding: 4px;
    border: 1px solid var(--mc-border);
    border-radius: var(--mc-radius);
    background: var(--mc-surface);
    color: var(--mc-text);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
    min-width: 11rem;
    position-area: block-end span-inline-start;
    position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline;
    inset: auto;
  }
  .menu:popover-open {
    display: flex;
    flex-direction: column;
  }
  .menu button {
    border: 0;
    text-align: start;
    background: transparent;
  }
  .menu a {
    padding: 8px 12px;
    color: inherit;
    text-decoration: none;
  }
  .empty {
    padding: 24px;
    text-align: center;
  }
  dialog {
    border: 1px solid var(--mc-border);
    border-radius: var(--mc-radius);
    background: var(--mc-surface);
    color: var(--mc-text);
    padding: var(--mc-gap);
    width: min(32rem, calc(100vw - 32px));
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.4);
  }
  dialog form {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  dialog label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-weight: 600;
  }
  dialog label .hint {
    font-weight: 400;
    font-size: 0.85rem;
    color: var(--mc-text-muted);
  }
  dialog .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-block-start: 6px;
  }
  .form-error {
    color: var(--mc-danger);
    margin: 0;
  }
`;
