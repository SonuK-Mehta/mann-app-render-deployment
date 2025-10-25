// middleware/validation.middleware.js - This is correct
import ApiError from '../utils/api-error.js';

export const validate = (schema, property = 'body') => {
  return (req, res, next) => {
    // ✅ ADD: Debug logging
    // console.log(`🔍 Validating ${property}:`, req[property]);
    // console.log(`🔍 Schema type:`, typeof schema);
    // console.log(`🔍 Schema has validate method:`, typeof schema.validate);

    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      convert: true,
    });

    if (error) {
      const errors = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message,
        value: detail.context?.value,
      }));

      throw ApiError.validation('Validation failed', errors);
    }

    req[property] = value;
    next();
  };
};
