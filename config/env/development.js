module.exports = {
    env: 'development',
    debugging: true,
    db: {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      pass: process.env.DB_PASS || 'Test@123',
      name: process.env.DB_NAME || 'social'
    }
  };
  