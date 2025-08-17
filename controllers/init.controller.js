exports.getInitialData = async (req, res) => {
    try {
      const system = req.system || {};
      const userInstance = req.userInstance;
  
      const response = {
        system,
        user: null,
        controlPanel: null,
      };
      
      if (userInstance && userInstance._logged_in) {
        // Check user ban
        if (userInstance._is_banned) {
          return res.status(403).json({ error: userInstance._data.user_banned_message });
        }
  
        response.user = {
          id: userInstance._data.user_id,
          name: userInstance._data.user_fullname,
          isAdmin: userInstance._is_admin,
          isModerator: userInstance._is_moderator,
          avatar: userInstance._data.user_picture,
          permissions: userInstance._data.user_permissions_group,
        };
  
        response.controlPanel = userInstance.controlPanel;
      }
  
      return res.json(response);
    } catch (err) {
      console.error('Init API error', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
  