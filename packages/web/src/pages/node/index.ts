/**
 * The node page: `/node/:key` (Info) and `/node/:key/:tab` — one page per node, contact or not
 * (`key` is a full public key, a key prefix or a bare path hash). See node-page.ts.
 * `/nodes/:prefix` lists every known node whose key starts with a hash / prefix (node-list-page.ts).
 */
import { registerPage } from '../../router.js';
import './node-page.js';
import './node-list-page.js';

const node = { title: 'Node', icon: '📡', tag: 'mc-node-page', nav: false, navParent: '/contacts', requiresConnection: true } as const;
registerPage({ path: '/node/:key', ...node });
registerPage({ path: '/node/:key/:tab', ...node });
registerPage({ path: '/nodes/:prefix', title: 'Nodes', icon: '📡', tag: 'mc-node-list-page', nav: false, navParent: '/contacts', requiresConnection: true });
