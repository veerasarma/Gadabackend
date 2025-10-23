const mysql = require('mysql2/promise');
require('dotenv').config();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
  queueLimit: 0,            // 0 = unlimited queue
  enableKeepAlive: true,    // mysql2 option
  keepAliveInitialDelay: 0,

});

module.exports = db;
