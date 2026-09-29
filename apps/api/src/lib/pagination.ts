import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

export function toSkipTake({ page, limit }: { page: number; limit: number }) {
  return { skip: (page - 1) * limit, take: limit };
}
