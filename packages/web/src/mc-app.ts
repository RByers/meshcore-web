/**
 * App shell: header (connection chip, disconnect), navigation from the page registry (sidebar
 * when wide, bottom bar when narrow), the routed page, and the toast stack.
 */
import { css, html, nothing } from 'lit';
import { CONNECTION_KIND_LABEL, type AppModel } from '@meshcore-web/core/app';
import { AppElement, provideApp } from './app-context.js';
import { PHASE_LABEL } from './format.js';
import { HashRouter, hrefFor, pages, type PageDef, type Route } from './router.js';
import { shared, tokens } from './styles.js';
import './components/mc-toasts.js';
import { SHOW_PATH_EVENT, type McPathDialog } from './components/path-dialog.js';
import './pages/index.js';
import { bindTheme } from './theme.js';
import { installErrorBoundary } from './error-boundary.js';

/** Elements rendered as pages get these properties. */
export interface PageElement extends HTMLElement {
  app?: AppModel;
  params?: Readonly<Record<string, string>>;
}

export class McApp extends AppElement {
  static override styles = [
    tokens,
    shared,
    css`
      :host {
        display: block;
        min-height: 100dvh;
        background: var(--mc-bg);
        container-type: inline-size;
        container-name: app;
      }
      .skip {
        position: absolute;
        inset-inline-start: 8px;
        inset-block-start: -40px;
        background: var(--mc-surface);
        padding: 6px 12px;
        border-radius: 8px;
        z-index: 2;
      }
      .skip:focus {
        inset-block-start: 8px;
      }
      .shell {
        display: grid;
        grid-template-columns: 13rem minmax(0, 1fr);
        grid-template-rows: auto 1fr;
        grid-template-areas: 'top top' 'nav main';
        min-height: 100dvh;
      }
      header.top {
        grid-area: top;
        display: flex;
        align-items: center;
        gap: 12px;
        /* viewport-fit=cover (index.html): keep controls out of notches / system bars */
        padding: calc(10px + env(safe-area-inset-top, 0px)) calc(var(--mc-gap) + env(safe-area-inset-right, 0px)) 10px
          calc(var(--mc-gap) + env(safe-area-inset-left, 0px));
        background: var(--mc-surface);
        border-block-end: 1px solid var(--mc-border);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .brand {
        font-weight: 700;
        font-size: 1.1rem;
        margin: 0;
        white-space: nowrap;
      }
      .spacer {
        flex: 1;
      }
      .chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        background: var(--mc-surface-2);
        font-size: 0.875rem;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dot {
        width: 0.6rem;
        height: 0.6rem;
        border-radius: 50%;
        background: var(--mc-text-muted);
        flex: none;
      }
      .chip[data-phase='connected'] .dot {
        background: var(--mc-ok);
      }
      .chip[data-phase='connecting'] .dot,
      .chip[data-phase='handshaking'] .dot,
      .chip[data-phase='disconnecting'] .dot {
        background: var(--mc-warn);
      }
      .chip[data-phase='error'] .dot {
        background: var(--mc-danger);
      }
      nav {
        grid-area: nav;
        background: var(--mc-surface);
        border-inline-end: 1px solid var(--mc-border);
        padding: 8px;
        padding-inline-start: calc(8px + env(safe-area-inset-left, 0px));
        padding-block-end: calc(8px + env(safe-area-inset-bottom, 0px));
      }
      nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
        position: sticky;
        top: 64px;
      }
      nav a {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        border-radius: 8px;
        color: var(--mc-text);
        text-decoration: none;
      }
      nav a:hover {
        background: var(--mc-surface-2);
      }
      nav a[aria-current='page'] {
        background: var(--mc-accent-soft);
        color: var(--mc-accent);
        font-weight: 600;
      }
      nav .icon {
        width: 1.5em;
        text-align: center;
      }
      nav .label {
        flex: 1;
      }
      .count {
        font-size: 0.75rem;
        min-width: 1.5em;
        padding: 0 6px;
        border-radius: 999px;
        background: var(--mc-accent);
        color: var(--mc-accent-text);
        text-align: center;
      }
      main {
        grid-area: main;
        padding: var(--mc-gap);
        padding-inline-end: calc(var(--mc-gap) + env(safe-area-inset-right, 0px));
        padding-block-end: calc(var(--mc-gap) + env(safe-area-inset-bottom, 0px));
        min-width: 0;
        /* page z-indexes (map overlays, sticky table heads) stay below the header and mobile nav */
        isolation: isolate;
      }
      main:focus {
        outline: none;
      }
      @container app (max-width: 640px) {
        .shell {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: auto 1fr auto;
          grid-template-areas: 'top' 'main' 'nav';
        }
        nav {
          position: sticky;
          bottom: 0;
          z-index: 1;
          border-inline-end: 0;
          border-block-start: 1px solid var(--mc-border);
          padding: 4px;
          padding-inline: calc(4px + env(safe-area-inset-left, 0px)) calc(4px + env(safe-area-inset-right, 0px));
          padding-block-end: max(4px, env(safe-area-inset-bottom, 0px));
        }
        main {
          padding-inline-start: calc(var(--mc-gap) + env(safe-area-inset-left, 0px));
          padding-block-end: var(--mc-gap);
        }
        nav ul {
          flex-direction: row;
          justify-content: space-around;
          position: static;
        }
        nav li {
          flex: 1;
        }
        nav a {
          flex-direction: column;
          gap: 2px;
          padding: 6px 2px;
          font-size: 0.7rem;
          text-align: center;
        }
        nav .icon {
          font-size: 1.2rem;
        }
        nav .count {
          position: absolute;
          margin-inline-start: 1.5rem;
        }
        .brand {
          font-size: 1rem;
        }
        .chip .where {
          display: none;
        }
        header.top {
          gap: 8px;
          padding-inline: calc(12px + env(safe-area-inset-left, 0px)) calc(12px + env(safe-area-inset-right, 0px));
        }
        header.top button {
          padding-inline: 0.75em;
        }
      }
    `,
  ];

  readonly router = new HashRouter(pages);
  #page: { def: PageDef; key: string; el: PageElement } | undefined;
  #offs: Array<() => void> = [];
  #lastPath: string | undefined;

  constructor() {
    super();
    provideApp(this, () => this.app);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.router.start(window);
    const conn = this.app.connection;
    this.#offs.push(
      conn.events.on('connected', () => {
        // land on the conversations overview when the messaging pages are registered
        if (this.router.path.peek() === '/') this.router.navigate(this.router.registry.match('/messages') ? '/messages' : '/device');
      }),
      conn.events.on('disconnected', () => {
        this.router.navigate('/');
      }),
    );
    void this.app.refreshDevices();
    this.#offs.push(bindTheme(this.app));
    this.#offs.push(installErrorBoundary(window, this.app.notifications, { now: () => this.app.clock.now() }));
    // "N hops" links anywhere below open the shared path view
    const onShowPath = (e: CustomEvent): void => {
      e.stopPropagation();
      void this.renderRoot.querySelector<McPathDialog>('mc-path-dialog')?.show(e.detail);
    };
    this.addEventListener(SHOW_PATH_EVENT, onShowPath);
    this.#offs.push(() => this.removeEventListener(SHOW_PATH_EVENT, onShowPath));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.#offs.splice(0)) off();
    this.router.stop();
  }

  #pageElement(route: Route): PageElement {
    const key = `${route.page.path}|${JSON.stringify(route.params)}`;
    if (this.#page?.def === route.page && this.#page.key === key) return this.#page.el;
    const el = document.createElement(route.page.tag) as PageElement;
    for (const [k, v] of Object.entries(route.page.attrs ?? {})) el.setAttribute(k, v);
    el.app = this.app;
    el.params = route.params;
    el.dataset['page'] = route.page.path;
    this.#page = { def: route.page, key, el };
    return el;
  }

  override render() {
    const conn = this.app.connection;
    const phase = conn.phase.value;
    const si = conn.selfInfo.value;
    const kind = conn.kind.value;
    let route = this.router.route;
    if (route?.page.requiresConnection && !conn.connected.value) {
      queueMicrotask(() => this.router.navigate('/', { replace: true }));
      route = this.router.registry.match('/');
    }
    const unread = conn.connected.value ? this.app.unread.totals.value : null;
    const counts: Record<string, number> = {
      '/messages': unread?.total ?? 0,
      '/contacts': unread?.contacts ?? 0,
      '/channels': unread?.channels ?? 0,
    };
    const current = route?.page.path;
    const navParent = route?.page.navParent;
    return html`
      <a class="skip" href="#main" @click=${this.#skip}>Skip to content</a>
      <div class="shell">
        <header class="top">
          <p class="brand">MeshCore Web</p>
          <span class="spacer"></span>
          <span class="chip" data-phase=${phase} role="status" aria-label=${`Connection: ${PHASE_LABEL[phase]}`}>
            <span class="dot" aria-hidden="true"></span>
            <span class="label">${PHASE_LABEL[phase]}</span>
            ${si && phase === 'connected'
              ? html`<span class="where">· ${si.name}${kind ? ` (${CONNECTION_KIND_LABEL[kind]})` : ''}</span>`
              : nothing}
          </span>
          ${phase === 'connected' || conn.busy.value
            ? html`<button class="danger" data-action="disconnect" ?disabled=${phase === 'disconnecting'}
                @click=${() => void conn.disconnect()}>
                ${phase === 'connected' ? 'Disconnect' : 'Cancel'}
              </button>`
            : nothing}
        </header>
        <nav aria-label="Main">
          <ul>
            ${this.router.registry.navPages().map(
              (p) => html`<li>
                <a href=${hrefFor(p.path)} aria-current=${p.path === current || p.path === navParent ? 'page' : nothing} data-path=${p.path}>
                  <span class="icon" aria-hidden="true">${p.icon}</span>
                  <span class="label">${p.title}</span>
                  ${(counts[p.path] ?? 0) > 0
                    ? html`<span class="count" aria-label=${`${counts[p.path]} unread`}>${counts[p.path]}</span>`
                    : nothing}
                </a>
              </li>`,
            )}
          </ul>
        </nav>
        <main id="main" tabindex="-1">
          ${route
            ? this.#pageElement(route)
            : html`<section class="card">
                <h2>Page not found</h2>
                <p><a href=${hrefFor('/')}>Go to Connect</a></p>
              </section>`}
        </main>
      </div>
      <mc-path-dialog .app=${this.app}></mc-path-dialog>
      <mc-toasts .app=${this.app}></mc-toasts>
    `;
  }

  override updated(): void {
    const route = this.router.route;
    const path = route?.path ?? this.router.path.peek();
    if (path !== this.#lastPath) {
      const first = this.#lastPath === undefined;
      this.#lastPath = path;
      if (route) document.title = route.page.path === '/' ? 'MeshCore Web' : `${route.page.title} · MeshCore Web`;
      // move focus to the content after an in-app navigation (not on first load)
      if (!first && this.matches(':focus-within')) this.renderRoot.querySelector<HTMLElement>('main')?.focus();
    }
  }

  #skip(e: Event): void {
    e.preventDefault();
    this.renderRoot.querySelector<HTMLElement>('main')?.focus();
  }
}

customElements.define('mc-app', McApp);

declare global {
  interface HTMLElementTagNameMap {
    'mc-app': McApp;
  }
}
