/** Build constants injected by vite `define` (see vite.config.ts). */

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
declare const __BUILD_ID__: string;

/** packages/web/package.json version. */
export const APP_VERSION: string = __APP_VERSION__;
/** ISO timestamp of the build (or of the dev-server / test start). */
export const BUILD_DATE: string = __BUILD_DATE__;
/** Unique per build; versions the service worker cache. */
export const BUILD_ID: string = __BUILD_ID__;

/**
 * Project repository. Placeholder until the repository is published — this is the only place
 * it is defined.
 */
export const REPO_URL = 'https://github.com/meshcore-web/meshcore-web';
export const MESHCORE_URL = 'https://meshcore.co.uk/';
export const MESHCORE_FIRMWARE_URL = 'https://github.com/meshcore-dev/MeshCore';
