/**
 * PWA glue: service-worker registration (production builds only) and the install prompt.
 *
 * Chromium fires `beforeinstallprompt` when the app is installable; we keep the event and offer
 * an "Install app" button (connect page) that calls `prompt()`. The listener is attached when
 * this module is first imported, so an event fired before the connect page renders is not lost.
 */
import { computed, signal, type ReadonlySignal } from '@meshcore-web/core/app';
import { BUILD_ID } from './build-info.js';

/** The non-standard `BeforeInstallPromptEvent` (Chromium). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice?: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

export class InstallPrompt {
  readonly #event = signal<BeforeInstallPromptEvent | null>(null);
  /** True while the browser offers installation. */
  readonly available: ReadonlySignal<boolean>;
  readonly #off: () => void;

  constructor(target: EventTarget = window) {
    this.available = computed(() => this.#event.value !== null);
    const onPrompt = (e: Event): void => {
      e.preventDefault(); // suppress the mini-infobar; we show our own button
      this.#event.value = e as BeforeInstallPromptEvent;
    };
    const onInstalled = (): void => {
      this.#event.value = null;
    };
    target.addEventListener('beforeinstallprompt', onPrompt);
    target.addEventListener('appinstalled', onInstalled);
    this.#off = () => {
      target.removeEventListener('beforeinstallprompt', onPrompt);
      target.removeEventListener('appinstalled', onInstalled);
    };
  }

  /** Shows the browser's install dialog; resolves to the user's choice. */
  async prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const e = this.#event.peek();
    if (!e) return 'unavailable';
    // a BeforeInstallPromptEvent can be used only once
    this.#event.value = null;
    await e.prompt();
    const choice = await e.userChoice;
    return choice?.outcome ?? 'dismissed';
  }

  dispose(): void {
    this.#off();
    this.#event.value = null;
  }
}

let installPrompt: InstallPrompt | undefined;

/** Page-wide install prompt tracker. */
export function getInstallPrompt(): InstallPrompt {
  installPrompt ??= new InstallPrompt();
  return installPrompt;
}

/**
 * Registers `sw.js` next to index.html (relative: the app is served from any base path).
 * The build id in the script URL makes each deploy install a new worker with a new cache.
 */
export async function registerServiceWorker(nav: Navigator = navigator): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in nav)) return undefined;
  try {
    return await nav.serviceWorker.register(`./sw.js?v=${encodeURIComponent(BUILD_ID)}`, { scope: './' });
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return undefined;
  }
}
