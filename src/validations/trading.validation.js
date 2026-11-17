import { z } from 'zod';

export const groupParams = z.object({
  params: z.object({ group: z.enum(['odd', 'even']) }),
});
