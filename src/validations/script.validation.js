import { z } from 'zod';
import {
  exactlyOneTarget,
  notificationBody,
  notificationTarget,
  notificationTitle,
} from './common.validation.js';

export const runScript = z.object({
  params: z.object({
    name: z.string().regex(/^[A-Za-z0-9][\w-]*$/, 'Invalid script name'),
  }),
  body: z
    .object({
      // Passed to the script as command-line arguments (process.argv.slice(2)).
      args: z.array(z.string()).max(50).default([]),
      // Optional push notification sent when the script finishes.
      notify: z
        .object({
          ...notificationTarget,
          when: z.enum(['always', 'success', 'failure']).default('always'),
          title: notificationTitle.optional(),
          body: notificationBody.optional(),
        })
        .refine(...exactlyOneTarget)
        .optional(),
    })
    // Allows calling the endpoint with no body at all.
    .prefault({}),
});
