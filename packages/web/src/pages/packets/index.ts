/** Phase 9 page registrations: packet / frame log and the inspector pages. */
import { registerPage } from '../../router.js';
import './packets-page.js';
import './packet-detail-page.js';

registerPage({ path: '/packets', title: 'Packets', icon: '📜', tag: 'mc-packets-page', order: 40 });
registerPage({ path: '/packets/:id', title: 'Packet', icon: '📜', tag: 'mc-packet-detail-page', nav: false, attrs: { kind: 'packet' } });
registerPage({ path: '/packets/node/:key', title: 'Packets', icon: '📜', tag: 'mc-packets-page', nav: false, navParent: '/packets' });
registerPage({ path: '/packets/frame/:id', title: 'Frame', icon: '📜', tag: 'mc-packet-detail-page', nav: false, attrs: { kind: 'frame' } });
