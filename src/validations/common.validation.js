import { z } from 'zod';

/** Record ids (letters, digits, "-" and "_"). */
export const recordId = z.string().regex(/^[\w-]{1,128}$/, 'Must be a valid id');

export const listQuery = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});

// Notification fields shared by "send a notification" and "notify when a script finishes".
export const notificationTitle = z.string().trim().min(1).max(200);
export const notificationBody = z.string().trim().min(1).max(1000);

export const notificationTarget = {
  token: z.string().trim().min(1).optional(),
  tokens: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
  topic: z
    .string()
    .regex(/^[\w.~%-]+$/, 'Topic may only contain letters, numbers and - _ . ~ %')
    .optional(),
};

export const exactlyOneTarget = [
  (value) => ['token', 'tokens', 'topic'].filter((key) => value[key] !== undefined).length === 1,
  'Provide exactly one of token, tokens or topic',
];
