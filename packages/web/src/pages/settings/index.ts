/**
 * Phase 11 page registrations: `/settings` (device + app settings). `/device` stays the
 * read-only overview from pages/device-page.ts.
 */
import { registerPage } from '../../router.js';
import './settings-page.js';

registerPage({ path: '/settings', title: 'Settings', icon: '⚙', tag: 'mc-settings-page', order: 50 });
