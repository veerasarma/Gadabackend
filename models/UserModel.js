const db = require('../config/db');

const getUserBySession = async (userId, token) => {
  const [rows] = await db.query(`
    SELECT u.*, us.session_token 
    FROM users u 
    JOIN users_sessions us ON u.user_id = us.user_id 
    WHERE u.user_id = ? AND us.session_token = ?
  `, [userId, token]);
  return rows[0];
};

module.exports = {
  getUserBySession,
};
