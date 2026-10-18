/**
 * Phase 7/8 page registrations: messages overview, contacts, channels, channel chat and contact
 * paths. DMs live in the node page's Messages tab (`/node/:key/messages`, pages/node/).
 */
import { registerPage } from '../../router.js';
import './messages-page.js';
import './contacts-page.js';
import './chat-page.js';
import './channels-page.js';
import './path-page.js';

registerPage({ path: '/messages', title: 'Messages', icon: '💬', tag: 'mc-messages-page', order: 15, requiresConnection: true });
registerPage({ path: '/contacts', title: 'Contacts', icon: '👥', tag: 'mc-contacts-page', order: 20, requiresConnection: true });
registerPage({ path: '/channels', title: 'Channels', icon: '#', tag: 'mc-channels-page', order: 30, requiresConnection: true });
registerPage({ path: '/path/:key', title: 'Path', icon: '🧭', tag: 'mc-path-page', nav: false, requiresConnection: true });
registerPage({ path: '/channel/:key', title: 'Channel', icon: '#', tag: 'mc-chat-page', nav: false, requiresConnection: true, attrs: { mode: 'channel' } });
