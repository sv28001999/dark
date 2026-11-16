import { z } from 'zod';

export const updateSettings = z.object({
  body: z.object({
    // At most 20: streaks are counted over each group's latest 20 records.
    upStreakAlert: z.number().int().min(1).max(20),
  }),
});
