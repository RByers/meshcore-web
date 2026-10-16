/** Phase 12 page registration: `/map` (contacts with a location and this radio). */
import { registerPage } from '../../router.js';
import './map-page.js';

registerPage({ path: '/map', title: 'Map', icon: '🗺', tag: 'mc-map-page', order: 35, requiresConnection: true });
