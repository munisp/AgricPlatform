import { BadRequestException, Injectable } from '@nestjs/common';
import {
  cellToBoundary,
  cellToLatLng,
  getResolution,
  gridDisk,
  isValidCell,
  latLngToCell
} from 'h3-js';
import { H3_RESOLUTIONS, type H3IndexEntry, type H3Resolution } from '@agric-platform/shared';

/** Largest k-ring allowed for neighbourhood queries (fail-closed bound). */
export const MAX_GEO_RING = 10;

/**
 * Thin application-layer wrapper over h3-js (Wave GEO). This is the ONLY
 * place the H3 library is imported: all spatial indexing on the platform is
 * computed here (no PostGIS — CI runs postgres:16-alpine) and persisted to
 * geo.h3_index (migration 026). Swapping the geometry engine later means
 * changing this one service.
 */
@Injectable()
export class H3Service {
  /** Validates coordinate ranges (fail-closed) before touching h3-js. */
  assertCoordinates(lat: number, long: number): void {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new BadRequestException('lat must be a finite number between -90 and 90');
    }
    if (!Number.isFinite(long) || long < -180 || long > 180) {
      throw new BadRequestException('long must be a finite number between -180 and 180');
    }
  }

  assertResolution(resolution: number): H3Resolution {
    if (!H3_RESOLUTIONS.includes(resolution as H3Resolution)) {
      throw new BadRequestException(
        `res must be one of ${H3_RESOLUTIONS.join(', ')} (the indexed resolutions)`
      );
    }
    return resolution as H3Resolution;
  }

  /** H3 cell containing (lat, long) at a single resolution. */
  cellAt(lat: number, long: number, resolution: number): string {
    this.assertCoordinates(lat, long);
    return latLngToCell(lat, long, resolution);
  }

  /** Cells at all three indexed resolutions for one point. */
  indexPoint(lat: number, long: number): Pick<H3IndexEntry, 'h3Res5' | 'h3Res7' | 'h3Res9'> {
    this.assertCoordinates(lat, long);
    return {
      h3Res5: latLngToCell(lat, long, 5),
      h3Res7: latLngToCell(lat, long, 7),
      h3Res9: latLngToCell(lat, long, 9)
    };
  }

  /** k-ring neighbourhood around a cell (gridDisk), ring capped fail-closed. */
  disk(cell: string, ring: number): string[] {
    this.assertCell(cell);
    if (!Number.isInteger(ring) || ring < 0 || ring > MAX_GEO_RING) {
      throw new BadRequestException(`ring must be an integer between 0 and ${MAX_GEO_RING}`);
    }
    return gridDisk(cell, ring);
  }

  /** Cell centre as [lat, long]. */
  center(cell: string): [number, number] {
    this.assertCell(cell);
    const [lat, long] = cellToLatLng(cell);
    return [lat, long];
  }

  /**
   * Cell boundary as a CLOSED GeoJSON Polygon ring of [long, lat] positions
   * (GeoJSON coordinate order), ready for map rendering.
   */
  boundaryGeojson(cell: string): { type: 'Polygon'; coordinates: number[][][] } {
    this.assertCell(cell);
    // cellToBoundary(cell, true) returns open [lng, lat] pairs.
    const ring = cellToBoundary(cell, true).map(([long, lat]) => [long, lat]);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ring.push([...first]);
    }
    return { type: 'Polygon', coordinates: [ring] };
  }

  resolutionOf(cell: string): number {
    this.assertCell(cell);
    return getResolution(cell);
  }

  assertCell(cell: string): void {
    if (typeof cell !== 'string' || !isValidCell(cell)) {
      throw new BadRequestException(`'${cell}' is not a valid H3 cell index`);
    }
  }
}
