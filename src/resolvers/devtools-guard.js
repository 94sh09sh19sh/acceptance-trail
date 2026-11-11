import { getAppContext } from '@forge/api';

// Developer tools (simulated tampering) are enabled only when BOTH hold:
//   1. The Forge runtime reports the development environment. This value comes from the
//      platform, not from the browser, so a production install can never pass it.
//   2. The environment variable EC_DEV_TOOLS is "1". It is set only on development with
//      `forge variables set -e development EC_DEV_TOOLS 1`; production has no such variable.
export function devToolsEnabled() {
  try {
    return getAppContext().environmentType === 'DEVELOPMENT' && process.env.EC_DEV_TOOLS === '1';
  } catch {
    return false;
  }
}
