const db = require('../config/db');

async function initSystem() {
  const system = {};

  // Load basic system options
  const [options] = await db.query("SELECT * FROM system_options");
  options.forEach(opt => {
    system[opt.option_name] = opt.option_value;
  })

  system.system_version = process.env.SYSTEM_VERSION;
  system.DEBUGGING = process.env.NODE_ENV !== 'production';
  system.system_url = process.env.CLIENT_ORIGIN;

  // Add CDN / Upload URL resolution


  // You can include theme, language, currency, etc. here as needed

  return system;
}


module.exports = initSystem;
