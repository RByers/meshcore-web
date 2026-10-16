import './mc-app.js';
import { getInstallPrompt, registerServiceWorker } from './pwa.js';

getInstallPrompt();
if (import.meta.env.PROD) {
  window.addEventListener('load', () => void registerServiceWorker(), { once: true });
}
