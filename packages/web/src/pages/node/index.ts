/**
 * The node page: `/node/:key` (Info) and `/node/:key/:tab` — one page per node, contact or not
 * (`key` is a full public key, a key prefix or a bare path hash). See node-page.ts.
 */
import { registerPage } from '../../router.js';
import './node-page.js';

const node = { title: 'Node', icon: '📡', tag: 'mc-node-page', nav: false, navParent: '/contacts', requiresConnection: true } as const;
registerPage({ path: '/node/:key', ...node });
registerPage({ path: '/node/:key/:tab', ...node });
