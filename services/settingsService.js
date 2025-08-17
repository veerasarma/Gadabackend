const pool = require('../config/db'); // your promise pool

const KEYS = ['general','features','moderation','storage','email','security'];

async function getAllSettings() {
  const [rows] = await pool.query(`SELECT \`key\`, \`value\` FROM admin_settings WHERE \`key\` IN (?)`, [KEYS]);
  const map = Object.fromEntries(KEYS.map(k => [k, {}]));
  for (const r of rows) {
    // if value is text, JSON.parse; if JSON type, driver returns object already
    map[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value || {};
  }
  return map;
}

async function getSettings(key) {
  const [[row]] = await pool.query(`SELECT \`value\` FROM admin_settings WHERE \`key\`=?`, [key]);
  if (!row) return {};
  return typeof row.value === 'string' ? JSON.parse(row.value) : row.value || {};
}

async function setSettings(key, obj) {
  // upsert
  const val = JSON.stringify(obj);
  await pool.query(
    `INSERT INTO admin_settings (\`key\`,\`value\`) VALUES (?,?)
     ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`)`,
    [key, val]
  );
  return true;
}

module.exports = { getAllSettings, getSettings, setSettings, KEYS };
