const cron = require('node-cron');
const pool          = require('../config/db');

cron.schedule('0 * * * *', async () => {
  await pool.query(
    `DELETE FROM stories WHERE time < NOW() - INTERVAL 1 DAY`
  );
  console.log('Expired stories cleaned up');
});
