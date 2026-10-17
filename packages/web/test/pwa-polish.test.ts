import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/mc-app.js';
import { APP_VERSION, BUILD_DATE, REPO_URL } from '../src/build-info.js';
import { installErrorBoundary } from '../src/error-boundary.js';
import { InstallPrompt, getInstallPrompt } from '../src/pwa.js';
import { NotificationsModel } from '@meshcore-web/core/app';
import { createHarness, type Harness } from '../src/testing/harness.js';
import pkg from '../package.json' with { type: 'json' };

let h: Harness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  vi.restoreAllMocks();
});

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
  const prompt = vi.fn(async () => undefined);
  const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt,
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
  return { e, prompt };
}

describe('install prompt', () => {
  it('Settings shows "Install app" only after beforeinstallprompt, and prompts on click', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('mc-settings-page') && t.query('[data-section="app"]'), 2000, 'settings page');
    expect(t.query('[data-action="install"]')).toBeNull();

    const { e, prompt } = installEvent();
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await t.until(() => t.query('[data-action="install"]'), 2000, 'install button');
    expect(t.query('[data-section="install"]')).not.toBeNull();
    expect(t.query('[data-action="install"]')!.textContent).toContain('Install app');

    await t.click('[data-action="install"]');
    expect(prompt).toHaveBeenCalledTimes(1);
    // the event can be used once: the button goes away
    await t.until(() => !t.query('[data-action="install"]'), 2000, 'button hidden');
    expect(getInstallPrompt().available.value).toBe(false);
  });

  it('appinstalled hides the offer; prompt() without an event is a no-op', async () => {
    const target = new EventTarget();
    const ip = new InstallPrompt(target);
    expect(await ip.prompt()).toBe('unavailable');
    const { e } = installEvent('dismissed');
    target.dispatchEvent(e);
    expect(ip.available.value).toBe(true);
    target.dispatchEvent(new Event('appinstalled'));
    expect(ip.available.value).toBe(false);
    target.dispatchEvent(installEvent('dismissed').e);
    expect(await ip.prompt()).toBe('dismissed');
    ip.dispose();
  });
});

describe('error boundary', () => {
  it('an uncaught error event on window shows an error toast and logs it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = (h = createHarness());
    await t.mount();
    // dispatched synthetically (not thrown) so the test runner does not treat it as a failure
    window.dispatchEvent(new ErrorEvent('error', { message: 'kaboom', error: new Error('kaboom') }));
    await t.until(() => t.text().includes('kaboom'), 2000, 'toast');
    expect(t.text()).toContain('Something went wrong');
    expect(consoleError).toHaveBeenCalled();
    expect(t.app.notifications.toasts.value.filter((x) => x.kind === 'error')).toHaveLength(1);
  });

  it('unhandled rejections toast too, and repeats are deduplicated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const target = new EventTarget();
    const notifications = new NotificationsModel();
    let now = 1000;
    const off = installErrorBoundary(target, notifications, { dedupeMs: 5000, now: () => now });
    const reject = (reason: unknown): void => {
      const e = Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.resolve() });
      target.dispatchEvent(e);
    };
    reject(new Error('link lost'));
    reject(new Error('link lost'));
    target.dispatchEvent(new ErrorEvent('error', { message: 'link lost' }));
    expect(notifications.toasts.value).toHaveLength(1);
    expect(notifications.toasts.value[0]).toMatchObject({ kind: 'error', detail: 'link lost' });
    reject('other');
    expect(notifications.toasts.value).toHaveLength(2);
    target.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    expect(notifications.toasts.value).toHaveLength(2);
    now += 6000;
    reject(new Error('link lost'));
    expect(notifications.toasts.value).toHaveLength(3);
    off();
    reject(new Error('after off'));
    expect(notifications.toasts.value).toHaveLength(3);
    notifications.clear();
  });

  it('is removed when <mc-app> disconnects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const t = (h = createHarness());
    await t.mount();
    const app = t.app;
    t.el!.remove();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after unmount' }));
    expect(app.notifications.toasts.value).toHaveLength(0);
  });
});

describe('about section', () => {
  it('shows version, build date, repo link, licence and credits', async () => {
    const t = (h = createHarness());
    await t.mount();
    location.hash = '#/settings';
    await t.until(() => t.query('[data-section="about"]'), 3000, 'about');
    expect(APP_VERSION).toBe(pkg.version);
    expect(t.query('[data-field="version"]')!.textContent!.trim()).toBe(pkg.version);
    expect(Number.isNaN(Date.parse(BUILD_DATE))).toBe(false);
    expect(t.query('[data-field="build-date"] time')!.getAttribute('datetime')).toBe(BUILD_DATE);
    expect(t.query<HTMLAnchorElement>('[data-field="repo"]')!.href).toBe(new URL(REPO_URL).href);
    expect(t.query('[data-field="licence"]')!.textContent).toContain('MIT');
    expect(t.query('[data-section="about"]')!.textContent).toContain('MeshCore');
  });
});
