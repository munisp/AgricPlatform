/**
 * Configurable mock of expo-location for vitest. Defaults to granted
 * permission and a good-accuracy fix; override with the __set helpers.
 */

export enum Accuracy {
  Lowest = 1,
  Low = 2,
  Balanced = 3,
  High = 4,
  Highest = 5,
  BestForNavigation = 6
}

let granted = true;
let canAskAgain = true;
let position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
} = {
  coords: { latitude: 11.0855, longitude: 7.7199, accuracy: 6 },
  timestamp: Date.now()
};
let positionError: Error | null = null;

export async function requestForegroundPermissionsAsync() {
  return { granted, canAskAgain, status: granted ? 'granted' : 'denied' };
}

export async function getForegroundPermissionsAsync() {
  return requestForegroundPermissionsAsync();
}

export async function getCurrentPositionAsync(_options?: unknown) {
  if (positionError) throw positionError;
  return position;
}

export function __setPermission(next: { granted: boolean; canAskAgain?: boolean }): void {
  granted = next.granted;
  canAskAgain = next.canAskAgain ?? true;
}

export function __setPosition(next: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}): void {
  position = {
    coords: {
      latitude: next.latitude,
      longitude: next.longitude,
      accuracy: next.accuracy ?? null
    },
    timestamp: Date.now()
  };
  positionError = null;
}

export function __failPosition(error: Error | null): void {
  positionError = error;
}

export function __reset(): void {
  granted = true;
  canAskAgain = true;
  positionError = null;
  __setPosition({ latitude: 11.0855, longitude: 7.7199, accuracy: 6 });
}
