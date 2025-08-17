require('dotenv').config(); // Load .env
const env = process.env.NODE_ENV || 'development';

const config = require(`./env/${env}.js`);
module.exports = config;


