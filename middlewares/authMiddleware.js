const { verifyUserSession } = require('../services/AuthService');

const authenticate = async (req, res, next) => {
  const user = await verifyUserSession(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  req.user = user;
  next();
};

module.exports = authenticate;
