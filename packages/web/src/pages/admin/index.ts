/**
 * Phase 10 page registrations: repeater / room server / sensor administration. Import after
 * `./messaging/index.js` so `/node/:key` replaces the messaging placeholder (node-page.ts).
 */
import { registerPage } from '../../router.js';
import './node-admin-page.js';

registerPage({ path: '/node/:key', title: 'Node', icon: '📡', tag: 'mc-node-admin-page', nav: false, requiresConnection: true });
registerPage({ path: '/node/:key/:tab', title: 'Node', icon: '📡', tag: 'mc-node-admin-page', nav: false, requiresConnection: true });
