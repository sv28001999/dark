import { z } from 'zod';

export const registerDevice = z.object({
  body: z.object({
    // FCM registration token from the mobile app.
    token: z.string().trim().min(1).max(4096),
    platform: z.enum(['android', 'ios']),
  }),
});
