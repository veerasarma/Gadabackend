const db = require('./db'); // mysql2/promise connection
const os = require('os');

let systemCache = null;

async function initSystemConfig() {
  if (systemCache) return systemCache;

  const system = {};

  // 1. Load system options
  const [options] = await db.query('SELECT * FROM system_options');
  options.forEach(opt => {
    system[opt.option_name] = opt.option_value;
  });

  // // 2. Add constants
  // system.system_version = process.env.SYSTEM_VERSION || '1.0.0';
  system.system_url = process.env.SYSTEM_URL;
  // system.DEBUGGING = process.env.DEBUG === 'true';

  // // 3. Derive date format
  // system.system_date_format = (system.system_datetime_format || 'YYYY-MM-DD HH:mm:ss').split(' ')[0];

  // // 4. Upload endpoints
  // if (system.uploads_cdn_url) {
  //   system.system_uploads = system.uploads_cdn_url;
  // } else if (system.s3_enabled === '1') {
  //   system.system_uploads = `https://s3.${system.s3_region}.amazonaws.com/${system.s3_bucket}/uploads`;
  // } else if (system.google_cloud_enabled === '1') {
  //   system.system_uploads = `https://storage.googleapis.com/${system.google_cloud_bucket}/uploads`;
  // } else if (system.digitalocean_enabled === '1') {
  //   system.system_uploads = `https://${system.digitalocean_space_name}.${system.digitalocean_space_region}.digitaloceanspaces.com/uploads`;
  // } else if (system.backblaze_enabled === '1') {
  //   system.system_uploads = `https://s3.${system.backblaze_region}.backblazeb2.com/${system.backblaze_bucket}/uploads`;
  // } else if (system.cloudflare_r2_enabled === '1') {
  //   system.system_uploads = `${system.cloudflare_r2_custom_domain}/uploads`;
  // } else {
  //   system.system_uploads = `${system.system_url}/${system.uploads_directory}`;
  // }

  // // 5. Agora uploads (live streaming)
  // if (system.live_enabled === '1' && system.save_live_enabled === '1') {
  //   system.system_agora_uploads = `https://s3.${system.agora_s3_region}.amazonaws.com/${system.agora_s3_bucket}`;
  // }

  // // 6. File extension conversion
  // const formatExtensions = ext => ext?.split(',').map(e => e.trim()).join('|') || '';
  // system.accpeted_video_extensions = formatExtensions(system.video_extensions);
  // system.accpeted_audio_extensions = formatExtensions(system.audio_extensions);
  // system.accpeted_file_extensions = formatExtensions(system.file_extensions);

  // // 7. Get themes
  // const [themes] = await db.query('SELECT * FROM system_themes');
  // system.themes = {};
  // themes.forEach(theme => {
  //   if (theme.enabled) {
  //     system.themes[theme.name] = theme;
  //   }
  //   if (theme.default) {
  //     system.theme = theme.name;
  //   }
  // });

  // // 8. Get languages
  // const [languages] = await db.query("SELECT * FROM system_languages WHERE enabled = '1' ORDER BY language_order");
  // system.languages = {};
  // for (let lang of languages) {
  //   lang.flag = `flags/${lang.flag}`; // or use get_picture() logic if needed
  //   if (lang.default) {
  //     system.default_language = lang;
  //   }
  //   system.languages[lang.code] = lang;
  // }

  // // 9. Default language
  // system.current_language = process.env.DEFAULT_LOCALE || 'en';

  // // 10. Currency setup
  // const [currencyRows] = await db.query("SELECT * FROM system_currencies WHERE `default` = 1 LIMIT 1");
  // if (currencyRows.length) {
  //   const currency = currencyRows[0];
  //   system.system_currency = currency.code;
  //   system.system_currency_id = currency.currency_id;
  //   system.system_currency_symbol = currency.symbol;
  //   system.system_currency_dir = currency.dir;
  // }

  // // 11. Convert payment methods to arrays
  // system.wallet_payment_method_array = system.wallet_payment_method?.split(',') || [];
  // system.affiliate_payment_method_array = system.affiliate_payment_method?.split(',') || [];
  // system.points_payment_method_array = system.points_payment_method?.split(',') || [];
  // system.market_payment_method_array = system.market_payment_method?.split(',') || [];
  // system.funding_payment_method_array = system.funding_payment_method?.split(',') || [];
  // system.monetization_payment_method_array = system.monetization_payment_method?.split(',') || [];

  // // 12. IP blacklist
  // const [ipResult] = await db.query("SELECT COUNT(*) as count FROM blacklist WHERE node_type = 'ip' AND node_value = ?", [getUserIP()]);
  // system.viewer_ip_banned = ipResult[0].count > 0;

  systemCache = system;
  return system;
}

function getSystemConfig() {
  if (!systemCache) {
    throw new Error('System config not initialized');
  }
  return systemCache;
}

// Utility for user IP (you may also extract from req.ip with trust proxy)
function getUserIP() {
  const interfaces = os.networkInterfaces();
  for (let iface of Object.values(interfaces)) {
    for (let i of iface) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

module.exports = {
  initSystemConfig,
  getSystemConfig
};
