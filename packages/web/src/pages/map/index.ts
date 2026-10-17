/** Phase 12 page registration: `/map` (contacts with a location and this radio); `/map/node/:key` focuses one node. */
import { registerPage } from '../../router.js';
import './map-page.js';

registerPage({ path: '/map', title: 'Map', icon: '🗺', tag: 'mc-map-page', order: 35, requiresConnection: true });
registerPage({ path: '/map/node/:key', title: 'Map', icon: '🗺', tag: 'mc-map-page', nav: false, navParent: '/map', requiresConnection: true });
