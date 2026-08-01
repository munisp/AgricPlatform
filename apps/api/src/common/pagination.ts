import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { ApiListResponse } from '@agric-platform/shared';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = DEFAULT_PAGE_SIZE;
}

export function paginate<T>(items: T[], page = 1, pageSize = DEFAULT_PAGE_SIZE): ApiListResponse<T> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
  const start = (safePage - 1) * safeSize;
  return {
    data: items.slice(start, start + safeSize),
    total: items.length,
    page: safePage,
    pageSize: safeSize
  };
}
