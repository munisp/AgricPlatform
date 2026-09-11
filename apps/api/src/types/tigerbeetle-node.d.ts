/**
 * Minimal type declarations for tigerbeetle-node (CJS, no bundled types).
 * Only the surface used by tigerbeetle.driver.ts is declared: createClient,
 * whose return value the driver narrows to its own TigerBeetleClientLike
 * interface via a double cast.
 */
declare module 'tigerbeetle-node' {
  export function createClient(options: {
    cluster_id: bigint;
    replica_addresses: string[];
  }): unknown;
}
