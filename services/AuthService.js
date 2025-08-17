const jwt = require('jsonwebtoken');
const { getUserBySession } = require('../models/UserModel');

const verifyUserSession = async (req) => {
  const token = req.cookies?.xs || req.headers['x-auth-token'];
  const userId = req.cookies?.c_user;

  if (!token || !userId) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.uid != userId) return null;

    const user = await getUserBySession(userId, decoded.token);
    return user || null;
  } catch (err) {
    console.error('JWT error:', err.message);
    return null;
  }
};

module.exports = {
  verifyUserSession,
};
