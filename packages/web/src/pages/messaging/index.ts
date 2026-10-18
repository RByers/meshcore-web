/**
 * Phase 7/8 page registrations: messages overview, contacts, channels and channel chat. DMs and
 * contact paths live in the node page's Messages and Path tabs (`/node/:key/messages|path`, pages/node/).
 */
import { registerPage } from '../../router.js';
import './messages-page.js';
import './contacts-page.js';
import './chat-page.js';
import './channels-page.js';

registerPage({ path: '/messages', title: 'Messages', icon: '💬', tag: 'mc-messages-page', order: 15, requiresConnection: true });
registerPage({ path: '/contacts', title: 'Contacts', icon: '👥', tag: 'mc-contacts-page', order: 20, requiresConnection: true });
registerPage({ path: '/channels', title: 'Channels', icon: '#', tag: 'mc-channels-page', order: 30, requiresConnection: true });
registerPage({ path: '/channel/:key', title: 'Channel', icon: '#', tag: 'mc-chat-page', nav: false, requiresConnection: true, attrs: { mode: 'channel' } });
