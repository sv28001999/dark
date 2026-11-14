import ApiError from './ApiError.js';

/**
 * Validates a request against a Zod schema shaped like z.object({ params, query, body }) and returns
 * the parsed values (coerced, defaulted, unknown keys removed). Throws a 400 listing every invalid field.
 *
 * Usage in a controller:  const { params, body } = validateRequest(req, schema);
 */
export default function validateRequest(req, schema) {
  const result = schema.safeParse({ params: req.params, query: req.query, body: req.body });

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));
    throw ApiError.badRequest('Validation failed', details);
  }

  return result.data;
}
