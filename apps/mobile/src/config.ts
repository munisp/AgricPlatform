import Constants from 'expo-constants';

/**
 * Runtime configuration. The API base URL ships in app.json `extra.apiBaseUrl`
 * and is overridden per build flavour (dev/staging/prod) via EAS — no secrets
 * are ever bundled here.
 */
export const API_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  'http://localhost:3001/api/v1';
