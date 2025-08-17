const path = require('path');
const envProdPath = path.join(__dirname, '.env-prod');
const envDevPath  = path.join(__dirname, '.env');

module.exports = {
  apps: [
    {
      name: 'social-api',
      script: 'app.js',
      cwd: path.resolve(__dirname),
      exec_mode: 'cluster',
      instances: '1',
      watch: false,
      max_memory_restart: '1G',

      // no node_args here, the app loads dotenv itself
      env: {
        NODE_ENV: 'development',
        DOTENV_CONFIG_PATH: envDevPath,
      },
      env_production: {
        NODE_ENV: 'production',
        DOTENV_CONFIG_PATH: envProdPath,
      },

      out_file: './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
    }
  ]
};
