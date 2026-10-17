/**
 * Applies the app theme preference to the document: `data-theme` on `<html>` ('system' |
 * 'light' | 'dark') plus its `color-scheme`. The tokens in styles.ts follow `data-theme` via
 * `:host-context()`; 'system' keeps `color-scheme: light dark` (the OS preference).
 *
 * index.html has one `<meta name="theme-color" data-scheme="light|dark" media=…>` per scheme
 * (browser / installed-app title and system bars); an explicit theme forces its own one.
 */
import { effect, type AppModel } from '@meshcore-web/core/app';

export function bindTheme(app: AppModel, root: HTMLElement = document.documentElement): () => void {
  return effect(() => {
    const theme = app.appSettings.theme.value;
    root.dataset['theme'] = theme;
    root.style.colorScheme = theme === 'system' ? 'light dark' : theme;
    for (const meta of root.ownerDocument.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-scheme]')) {
      const scheme = meta.dataset['scheme'];
      meta.media = theme === 'system' ? `(prefers-color-scheme: ${scheme})` : scheme === theme ? 'all' : 'not all';
    }
  });
}
