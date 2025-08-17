const initSystem = require('../services/initSystem');

module.exports = async function attachSystem(req, res, next) {
  try {
    const system = await initSystem();
    req.system = system;
    // const user = await initUser();
    // req.system = user;
    next();
  } catch (err) {
    console.error('System init failed', err);
    res.status(500).json({ error: 'System initialization failed' });
  }
};
