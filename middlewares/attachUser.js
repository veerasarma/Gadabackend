const { getUserInstance } = require('../services/AuthService');

module.exports = async function attachUser(req, res, next) {
  try {
    const user = await getUserInstance(req); // Validate token/cookie
    req.userInstance = user;
    next();
  } catch (err) {
    req.userInstance = null; // not logged in
    next();
  }
};
