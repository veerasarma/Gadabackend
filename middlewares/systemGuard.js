const { getSystemConfig } = require('../config/systemLoader');

function systemGuard({ allowGuests = false } = {}) {
    return (req, res, next) => {
      const system = req.system;
      const user = req.userInstance;
  
      // 1. Maintenance mode check
      if (!system.system_live) {
        const isAdmin = user._logged_in && user._data.user_group == 1;
        if (!isAdmin) {
          return res.status(503).json({
            status: 'error',
            message: system.system_message || 'System under maintenance',
          });
        }
      }
  
      // 2. IP banned check
      if (system.viewer_ip_banned) {
        return res.status(403).json({
          status: 'error',
          message: 'Your IP has been blocked',
        });
      }
  
      // 3. User banned check
      if (user._is_banned) {
        return res.status(403).json({
          status: 'error',
          message: user._data.user_banned_message || 'Account is banned',
        });
      }
  
      next();
    };
  }
  
  module.exports = systemGuard;
  
