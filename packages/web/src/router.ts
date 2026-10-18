/**
 * Hash router + page registry. Later phases add pages by registering them:
 *
 *   import { registerPage } from '../router.js';
 *   import './contacts-page.js'; // defines <mc-contacts-page>
 *   registerPage({ path: '/contacts', title: 'Contacts', icon: '👥', tag: 'mc-contacts-page', order: 20 });
 *   registerPage({ path: '/channel/:key', title: 'Channel', icon: '#', tag: 'mc-chat-page', nav: false, requiresConnection: true, attrs: { mode: 'channel' } });
 *
 * Registering an existing path replaces it (later registrations win). Page
 * elements receive `.app` (the AppModel) and `.params` (path parameters) properties.
 */
import { signal, type ReadonlySignal, type Signal } from '@meshcore-web/core/app';

export interface PageDef {
  /** '/', '/device', '/contacts/:key' … (':name' segments become params). */
  path: string;
  title: string;
  /** Short text/emoji icon shown in the nav. */
  icon: string;
  /** Custom element tag rendering the page. */
  tag: string;
  /** Show in the navigation (default true; false for detail pages). */
  nav?: boolean;
  /** Nav entry highlighted while this (non-nav) page is shown, e.g. '/map' for '/map/node/:key'. */
  navParent?: string;
  /** Nav order (ascending; default 100). */
  order?: number;
  /** Redirect to '/' while not connected (default false). */
  requiresConnection?: boolean;
  /** Extra attributes set on the page element (e.g. a placeholder's feature name). */
  attrs?: Readonly<Record<string, string>>;
}

export interface Route {
  page: PageDef;
  params: Readonly<Record<string, string>>;
  /** The matched path (without '#'). */
  path: string;
}

function compile(path: string): (p: string) => Record<string, string> | null {
  const parts = path.split('/').filter(Boolean);
  return (p) => {
    const segs = p.split('/').filter(Boolean);
    if (segs.length !== parts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const want = parts[i]!;
      const got = segs[i]!;
      if (want.startsWith(':')) {
        try {
          params[want.slice(1)] = decodeURIComponent(got);
        } catch {
          return null;
        }
      } else if (want !== got) return null;
    }
    return params;
  };
}

export class PageRegistry {
  readonly #pages = signal<readonly PageDef[]>([]);
  readonly #matchers = new Map<string, (p: string) => Record<string, string> | null>();
  /** All pages, in nav order. */
  readonly pages: ReadonlySignal<readonly PageDef[]> = this.#pages.readonly;

  register(def: PageDef): () => void {
    this.#matchers.set(def.path, compile(def.path));
    const others = this.#pages.peek().filter((p) => p.path !== def.path);
    this.#pages.value = [...others, def].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return () => {
      this.#pages.value = this.#pages.peek().filter((p) => p !== def);
    };
  }

  /** Pages shown in the nav. */
  navPages(): PageDef[] {
    return this.#pages.value.filter((p) => p.nav !== false);
  }

  match(path: string): Route | null {
    // static paths win over parameterised ones
    const pages = [...this.#pages.peek()].sort((a, b) => Number(a.path.includes(':')) - Number(b.path.includes(':')));
    for (const page of pages) {
      const params = this.#matchers.get(page.path)?.(path);
      if (params) return { page, params, path };
    }
    return null;
  }
}

/** The app-wide registry. */
export const pages = new PageRegistry();

export function registerPage(def: PageDef): () => void {
  return pages.register(def);
}

/** Normalises '#/x', '#x', '' to '/x' / '/'. */
export function pathFromHash(hash: string): string {
  const p = hash.replace(/^#/, '');
  if (!p) return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

export function hrefFor(path: string): string {
  return `#${path}`;
}

/** Follows `location.hash`; `route` is null for an unknown path. */
export class HashRouter {
  readonly #path: Signal<string>;
  readonly path: ReadonlySignal<string>;
  #win: Window | undefined;
  readonly #onHash = (): void => {
    if (this.#win) this.#path.value = pathFromHash(this.#win.location.hash);
  };

  constructor(readonly registry: PageRegistry = pages) {
    this.#path = signal('/');
    this.path = this.#path.readonly;
  }

  get route(): Route | null {
    void this.registry.pages.value; // re-match when pages are registered
    return this.registry.match(this.#path.value);
  }

  start(win: Window = window): void {
    if (this.#win) return;
    this.#win = win;
    win.addEventListener('hashchange', this.#onHash);
    this.#onHash();
  }

  stop(): void {
    this.#win?.removeEventListener('hashchange', this.#onHash);
    this.#win = undefined;
  }

  /** Navigates (adds a history entry unless `replace`). */
  navigate(path: string, opts: { replace?: boolean } = {}): void {
    const win = this.#win;
    if (!win) {
      this.#path.value = path;
      return;
    }
    if (pathFromHash(win.location.hash) === path) return;
    if (opts.replace) {
      win.history.replaceState(win.history.state, '', hrefFor(path));
      this.#path.value = path;
    } else {
      win.location.hash = path; // fires hashchange
      this.#path.value = path;
    }
  }
}
