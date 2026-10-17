/**
 * Phase 7/8 page registrations: messages overview, contacts, DM chat, channels, channel chat and
 * the node summary (replaced by the remote-admin phase).
 */
import { registerPage } from '../../router.js';
import './messages-page.js';
import './contacts-page.js';
import './chat-page.js';
import './contact-info-page.js';
import './channels-page.js';
import './path-page.js';

registerPage({ path: '/messages', title: 'Messages', icon: '💬', tag: 'mc-messages-page', order: 15, requiresConnection: true });
registerPage({ path: '/contacts', title: 'Contacts', icon: '👥', tag: 'mc-contacts-page', order: 20, requiresConnection: true });
registerPage({ path: '/channels', title: 'Channels', icon: '#', tag: 'mc-channels-page', order: 30, requiresConnection: true });
registerPage({ path: '/contact/:key', title: 'Contact', icon: '👤', tag: 'mc-contact-info-page', nav: false, requiresConnection: true });
registerPage({ path: '/chat/:key', title: 'Chat', icon: '💬', tag: 'mc-chat-page', nav: false, requiresConnection: true, attrs: { mode: 'contact' } });
registerPage({ path: '/path/:key', title: 'Path', icon: '🧭', tag: 'mc-path-page', nav: false, requiresConnection: true });
registerPage({ path: '/channel/:key', title: 'Channel', icon: '#', tag: 'mc-chat-page', nav: false, requiresConnection: true, attrs: { mode: 'channel' } });
