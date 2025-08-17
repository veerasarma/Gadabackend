class AppError extends Error {
    constructor(message, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
      this.name = this.constructor.name;
      Error.captureStackTrace(this, this.constructor);
    }
  }
  
  class SQLException extends AppError {
    constructor(message) {
      super(message, 500);
    }
  }
  
  class ValidationException extends AppError {
    constructor(message) {
      super(message, 400);
    }
  }
  
  class AuthorizationException extends AppError {
    constructor(message) {
      super(message, 403);
    }
  }
  
  class BadRequestException extends AppError {
    constructor(message) {
      super(message, 400);
    }
  }
  
  class NoDataException extends AppError {
    constructor(message) {
      super(message, 404);
    }
  }
  
  module.exports = {
    AppError,
    SQLException,
    ValidationException,
    AuthorizationException,
    BadRequestException,
    NoDataException,
  };
  