/**
 * Page registrations. Each feature folder registers its own pages; later registrations for the
 * same path replace earlier ones (see router.ts).
 */
import { registerPage } from '../router.js';
import './connect-page.js';
import './device-page.js';

registerPage({ path: '/', title: 'Connect', icon: '🔗', tag: 'mc-connect-page', order: 0 });
registerPage({ path: '/device', title: 'Device', icon: '📟', tag: 'mc-device-page', order: 10, requiresConnection: true });

import './messaging/index.js';
import './node/index.js';
import './packets/index.js';
import './map/index.js';
import './settings/index.js';
