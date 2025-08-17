const { AppError } = require('../utils/errors');
const config = require('../config');

const errorHandler = (err, req, res, next) => {
  if (config.debugging) {
    console.error(`[${err.name}]`, err.stack);
  } else {
    console.error(`[${err.name}]`, err.message);
  }

  res.status(err.statusCode || 500).json({
    error: config.debugging ? err.message : 'Something went wrong'
  });
};

module.exports = errorHandler;
