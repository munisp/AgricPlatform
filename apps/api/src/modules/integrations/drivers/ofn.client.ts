/**
 * Open Food Network (OFN) syndication client (wave P5a, matrix Phase 3).
 * Pushes NYFN marketplace listings to the hub's OFN enterprise via the
 * Spree-derived products API (`X-Spree-Token` auth). Inbound OFN order
 * events arrive on the federation webhook and are handled by
 * OfnSyndicationService. Fail closed: a non-stub OFN_DRIVER without the
 * full credential set raises ProviderConfigError at construction.
 */
import { httpJson, requireEnv } from './http.js';

/** Listing payload pushed to OFN (normalised from MarketplaceListing). */
export interface OfnListingPush {
  name: string;
  /** OFN enterprise (hub) id the product is listed under. */
  enterpriseId: string;
  price: number;
  /** Platform listing id carried as the OFN SKU for order correlation. */
  sku: string;
  description?: string;
}

export interface OfnPushResult {
  /** OFN product id assigned to the listing. */
  productId: string;
}

export class OfnClient {
  readonly name = 'ofn';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly enterpriseId: string
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /** Creates (or updates, by SKU) a product on the OFN enterprise. */
  async pushListing(listing: OfnListingPush): Promise<OfnPushResult> {
    const response = await httpJson<Record<string, unknown>>(this.name, this.url('/api/v0/products'), {
      method: 'POST',
      headers: { 'X-Spree-Token': this.apiKey },
      body: {
        name: listing.name,
        price: listing.price,
        sku: listing.sku,
        supplier_id: listing.enterpriseId,
        description: listing.description ?? ''
      }
    });
    return { productId: String(response?.['id'] ?? '') };
  }
}

/** True when OFN syndication may run (flag + credentials present). */
export function ofnDriverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OFN_DRIVER;
  return (
    (flag === 'live' || flag === 'production' || flag === 'sandbox') &&
    Boolean(env.OFN_BASE_URL && env.OFN_API_KEY && env.OFN_ENTERPRISE_ID)
  );
}

/** Fail-closed factory; returns undefined while the driver is stub. */
export function createOfnClient(env: NodeJS.ProcessEnv = process.env): OfnClient | undefined {
  const flag = env.OFN_DRIVER ?? 'stub';
  if (flag === 'stub') {
    return undefined;
  }
  const baseUrl = requireEnv('ofn', env, ['OFN_BASE_URL']);
  const apiKey = requireEnv('ofn', env, ['OFN_API_KEY']);
  const enterpriseId = requireEnv('ofn', env, ['OFN_ENTERPRISE_ID']);
  return new OfnClient(baseUrl, apiKey, enterpriseId);
}
