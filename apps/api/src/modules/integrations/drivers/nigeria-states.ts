/**
 * Nigeria state → geographic centroid table (wave P1). Used by the
 * OpenMeteo weather adapter to resolve a state name into lat/lon for the
 * forecast endpoint. Centroids are approximate state capitals/centres —
 * sufficient for state-level advisory snapshots (LGA precision is a P2
 * refinement, documented in docs/integration-matrix.md).
 */
export interface StateCentroid {
  state: string;
  latitude: number;
  longitude: number;
}

export const NIGERIA_STATE_CENTROIDS: readonly StateCentroid[] = [
  { state: 'Abia', latitude: 5.4527, longitude: 7.5248 },
  { state: 'Adamawa', latitude: 9.3265, longitude: 12.3984 },
  { state: 'Akwa Ibom', latitude: 5.0389, longitude: 7.9094 },
  { state: 'Anambra', latitude: 6.2209, longitude: 6.937 },
  { state: 'Bauchi', latitude: 10.3158, longitude: 9.8442 },
  { state: 'Bayelsa', latitude: 4.7719, longitude: 6.0699 },
  { state: 'Benue', latitude: 7.3369, longitude: 8.7404 },
  { state: 'Borno', latitude: 11.8846, longitude: 13.151 },
  { state: 'Cross River', latitude: 6.167, longitude: 8.66 },
  { state: 'Delta', latitude: 5.704, longitude: 6.094 },
  { state: 'Ebonyi', latitude: 6.1781, longitude: 7.9592 },
  { state: 'Edo', latitude: 6.5438, longitude: 5.8987 },
  { state: 'Ekiti', latitude: 7.6656, longitude: 5.3103 },
  { state: 'Enugu', latitude: 6.4413, longitude: 7.4988 },
  { state: 'FCT', latitude: 9.0765, longitude: 7.3986 },
  { state: 'Gombe', latitude: 10.3639, longitude: 11.1928 },
  { state: 'Imo', latitude: 5.5211, longitude: 6.9208 },
  { state: 'Jigawa', latitude: 12.57, longitude: 8.94 },
  { state: 'Kaduna', latitude: 10.5222, longitude: 7.4383 },
  { state: 'Kano', latitude: 11.9914, longitude: 8.5314 },
  { state: 'Katsina', latitude: 12.9908, longitude: 7.6018 },
  { state: 'Kebbi', latitude: 12.45, longitude: 4.1975 },
  { state: 'Kogi', latitude: 7.5619, longitude: 6.5783 },
  { state: 'Kwara', latitude: 8.5, longitude: 4.55 },
  { state: 'Lagos', latitude: 6.455, longitude: 3.3941 },
  { state: 'Nasarawa', latitude: 8.4997, longitude: 8.1995 },
  { state: 'Niger', latitude: 9.6137, longitude: 6.556 },
  { state: 'Ogun', latitude: 7.1475, longitude: 3.3619 },
  { state: 'Ondo', latitude: 7.2571, longitude: 5.2058 },
  { state: 'Osun', latitude: 7.548, longitude: 4.4977 },
  { state: 'Oyo', latitude: 7.3775, longitude: 3.947 },
  { state: 'Plateau', latitude: 9.8965, longitude: 8.8583 },
  { state: 'Rivers', latitude: 4.8156, longitude: 7.0498 },
  { state: 'Sokoto', latitude: 13.0627, longitude: 5.2432 },
  { state: 'Taraba', latitude: 7.8704, longitude: 9.7803 },
  { state: 'Yobe', latitude: 12.1871, longitude: 11.7068 },
  { state: 'Zamfara', latitude: 12.1844, longitude: 6.2376 }
];

const NORMALISED = new Map(
  NIGERIA_STATE_CENTROIDS.map((entry) => [entry.state.toLowerCase().replace(/\s+/g, ' ').trim(), entry])
);
// Common aliases.
NORMALISED.set('abuja', NORMALISED.get('fct') as StateCentroid);
NORMALISED.set('fct abuja', NORMALISED.get('fct') as StateCentroid);
NORMALISED.set('nassarawa', NORMALISED.get('nasarawa') as StateCentroid);

/** Case/whitespace-insensitive centroid lookup; undefined for unknown states. */
export function lookupStateCentroid(state: string): StateCentroid | undefined {
  return NORMALISED.get(state.toLowerCase().replace(/\s+/g, ' ').trim());
}
