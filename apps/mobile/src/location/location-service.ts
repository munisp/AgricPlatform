import * as ExpoLocation from 'expo-location';

/**
 * Real GPS provider for plot capture (Wave MOBFIX), backed by
 * expo-location. Kept behind the LocationService interface so screens and
 * tests can inject stubs — no silent fake coordinates ever reach a plot
 * record (fail-closed stays the default in PlotCaptureScreen).
 */

/** A single GPS reading. */
export interface GeoPoint {
  lat: number;
  long: number;
  accuracyMeters?: number;
}

/** GPS provider abstraction — production injects the expo-location adapter. */
export interface LocationService {
  getCurrentPoint(): Promise<GeoPoint>;
}

/**
 * Fixes worse than this are shown with a warning so the enumerator knows
 * the boundary may be unreliable. 50 m is a pragmatic threshold for
 * low-end Android GPS chips in the field (not a hard block — the honest
 * accuracy value is always stored with the point).
 */
export const GOOD_FIX_ACCURACY_METERS = 50;

/**
 * Raised when the user has denied foreground location permission. The UI
 * keys off this type to show permission guidance instead of a generic
 * error.
 */
export class LocationPermissionDeniedError extends Error {
  constructor(
    /** False when the OS will no longer show the prompt (must use Settings). */
    public readonly canAskAgain: boolean
  ) {
    super(
      canAskAgain
        ? 'Location permission was denied'
        : 'Location permission is off — enable it in your device Settings'
    );
    this.name = 'LocationPermissionDeniedError';
  }
}

/** Minimal surface of expo-location the adapter needs (injectable for tests). */
export interface LocationModuleLike {
  requestForegroundPermissionsAsync(): Promise<{ granted: boolean; canAskAgain?: boolean }>;
  getCurrentPositionAsync(options?: {
    accuracy?: number;
  }): Promise<{ coords: { latitude: number; longitude: number; accuracy: number | null } }>;
}

/**
 * expo-location adapter: requests foreground permission on first use
 * (rejects with LocationPermissionDeniedError when denied) and returns the
 * current position with its accuracy metadata. No coordinates are ever
 * fabricated — a failed read rejects and the caller decides how to surface
 * it.
 */
export function createExpoLocationService(
  location: LocationModuleLike = ExpoLocation
): LocationService {
  return {
    async getCurrentPoint(): Promise<GeoPoint> {
      const permission = await location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        throw new LocationPermissionDeniedError(permission.canAskAgain ?? false);
      }
      const position = await location.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High
      });
      return {
        lat: position.coords.latitude,
        long: position.coords.longitude,
        accuracyMeters: position.coords.accuracy ?? undefined
      };
    }
  };
}
