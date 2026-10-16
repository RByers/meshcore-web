/**
 * Phase 6 page registrations. Later phases replace a placeholder by registering a real page
 * with the same path (see router.ts).
 */
import { registerPage } from '../router.js';
import './connect-page.js';
import './device-page.js';
import './placeholder-page.js';

registerPage({ path: '/', title: 'Connect', icon: '🔗', tag: 'mc-connect-page', order: 0 });
registerPage({ path: '/device', title: 'Device', icon: '📟', tag: 'mc-device-page', order: 10, requiresConnection: true });

const placeholders = [
  { path: '/contacts', title: 'Contacts', icon: '👥', phase: '7', order: 20 },
  { path: '/channels', title: 'Channels', icon: '#', phase: '8', order: 30 },
  { path: '/packets', title: 'Packets', icon: '📜', phase: '9', order: 40 },
  { path: '/settings', title: 'Settings', icon: '⚙', phase: '11', order: 50 },
];
for (const p of placeholders) {
  registerPage({
    path: p.path,
    title: p.title,
    icon: p.icon,
    tag: 'mc-placeholder-page',
    order: p.order,
    attrs: { feature: p.title, phase: p.phase },
  });
}
