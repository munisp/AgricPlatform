/** Location adapter tests (audit P0-2): real accuracy metadata, fail-closed
 *  permission handling, no fabricated coordinates. */
import { describe, expect, it } from 'vitest';
import {
  createExpoLocationService,
  GOOD_FIX_ACCURACY_METERS,
  LocationPermissionDeniedError,
  type LocationModuleLike
} from '../src/location/location-service';

function moduleLike(overrides: Partial<LocationModuleLike> = {}): LocationModuleLike {
  return {
    async requestForegroundPermissionsAsync() {
      return { granted: true, canAskAgain: true };
    },
    async getCurrentPositionAsync() {
      return { coords: { latitude: 11.0855, longitude: 7.7199, accuracy: 6 } };
    },
    ...overrides
  };
}

describe('createExpoLocationService', () => {
  it('returns the current point with accuracy metadata', async () => {
    const service = createExpoLocationService(moduleLike());
    const point = await service.getCurrentPoint();
    expect(point).toEqual({ lat: 11.0855, long: 7.7199, accuracyMeters: 6 });
    expect(point.accuracyMeters).toBeLessThan(GOOD_FIX_ACCURACY_METERS);
  });

  it('requests foreground permission before reading the GPS', async () => {
    const order: string[] = [];
    const service = createExpoLocationService(
      moduleLike({
        async requestForegroundPermissionsAsync() {
          order.push('permission');
          return { granted: true, canAskAgain: true };
        },
        async getCurrentPositionAsync() {
          order.push('position');
          return { coords: { latitude: 1, longitude: 2, accuracy: 10 } };
        }
      })
    );
    await service.getCurrentPoint();
    expect(order).toEqual(['permission', 'position']);
  });

  it('rejects with LocationPermissionDeniedError when permission is denied', async () => {
    let positionRequested = false;
    const service = createExpoLocationService(
      moduleLike({
        async requestForegroundPermissionsAsync() {
          return { granted: false, canAskAgain: true };
        },
        async getCurrentPositionAsync() {
          positionRequested = true;
          return { coords: { latitude: 0, longitude: 0, accuracy: 1 } };
        }
      })
    );
    const error = await service.getCurrentPoint().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LocationPermissionDeniedError);
    expect((error as LocationPermissionDeniedError).canAskAgain).toBe(true);
    // Never falls through to a position read after a denial.
    expect(positionRequested).toBe(false);
  });

  it('flags a permanent denial (canAskAgain=false) for Settings guidance', async () => {
    const service = createExpoLocationService(
      moduleLike({
        async requestForegroundPermissionsAsync() {
          return { granted: false, canAskAgain: false };
        }
      })
    );
    const error = await service.getCurrentPoint().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LocationPermissionDeniedError);
    expect((error as LocationPermissionDeniedError).canAskAgain).toBe(false);
    expect((error as Error).message).toContain('Settings');
  });

  it('maps a missing accuracy reading to undefined (never invents one)', async () => {
    const service = createExpoLocationService(
      moduleLike({
        async getCurrentPositionAsync() {
          return { coords: { latitude: 9.08, longitude: 8.68, accuracy: null } };
        }
      })
    );
    const point = await service.getCurrentPoint();
    expect(point.lat).toBeCloseTo(9.08);
    expect(point.accuracyMeters).toBeUndefined();
  });

  it('propagates GPS hardware failures instead of fabricating a fix', async () => {
    const service = createExpoLocationService(
      moduleLike({
        async getCurrentPositionAsync() {
          throw new Error('location unavailable');
        }
      })
    );
    await expect(service.getCurrentPoint()).rejects.toThrow('location unavailable');
  });
});
