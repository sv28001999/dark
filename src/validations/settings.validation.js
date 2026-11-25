import { z } from 'zod';

// At most 20: streaks are counted over each group's latest 20 records.
const streakAlert = z.number().int().min(1).max(20);

export const updateSettings = z.object({
  body: z
    .object({
      upStreakAlert: streakAlert.optional(),
      downStreakAlert: streakAlert.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Give at least one setting to change'),
});
