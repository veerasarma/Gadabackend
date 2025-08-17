const crypto = require("crypto");

    function getHashKey(length = 8, onlyNumbers = false) {
        const chars = onlyNumbers ? '0123456789' : 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            const index = Math.floor(Math.random() * chars.length);
            result += chars.charAt(index);
        }
        return result;
    }

    function getDateTime() {
        return new Date().toISOString().slice(0, 19).replace('T', ' ');
    }

    function getClientIP(req) {
        const headers = [
            'cf-connecting-ip',      // Cloudflare
            'x-forwarded-for',       // Standard proxy header
            'x-real-ip',             // Nginx proxy
            'client-ip',             // Custom headers
        ];

        for (const header of headers) {
            const value = req.headers[header];
            if (value) {
                // If multiple IPs (e.g., "client, proxy1, proxy2") — take the first
                return value.split(',')[0].trim();
            }
        }

        // Fallback
        return req.connection?.remoteAddress || req.socket?.remoteAddress || '0.0.0.0';
    }

    function isValidURL(str) {
        const pattern = /^(https?:\/\/)?([\w\d\-]+\.)+\w{2,}(\/[\w\d#?&=.-]*)?$/i;
        return pattern.test(str);
    } 

    /**
     * Generates a secure MD5 hash token based on current time and random number.
     * @returns {string} md5 hash string
     */
    const getHashToken = () => {
        const raw = getHashNumber().toString();
        return crypto.createHash('md5').update(raw).digest('hex');
    };

    /**
     * Generates a random number based on current timestamp and a random multiplier.
     * @returns {number}
     */
    const getHashNumber = () => {
        return Date.now() * Math.floor(Math.random() * 99999 + 1);
    };

    const getUserBrowser = (userAgent) => {
        let browser = "Unknown Browser";
      
        if (!userAgent) {
          return browser;
        }
      
        const browserArray = [
          { regex: /msie/i, name: 'Internet Explorer' },
          { regex: /firefox/i, name: 'Firefox' },
          { regex: /safari/i, name: 'Safari' },
          { regex: /chrome/i, name: 'Chrome' },
          { regex: /edge/i, name: 'Edge' },
          { regex: /opera/i, name: 'Opera' },
          { regex: /netscape/i, name: 'Netscape' },
          { regex: /maxthon/i, name: 'Maxthon' },
          { regex: /konqueror/i, name: 'Konqueror' },
          { regex: /mobile/i, name: 'Handheld Browser' },
        ];
      
        for (const entry of browserArray) {
          if (entry.regex.test(userAgent)) {
            browser = entry.name;
            break;
          }
        }
      
        return browser;
      };

      const getUserOS = (userAgent) => {
        let osPlatform = "Unknown OS Platform";
      
        if (!userAgent) return osPlatform;
      
        const osArray = [
          { regex: /windows nt 10/i, name: 'Windows 10' },
          { regex: /windows nt 6.3/i, name: 'Windows 8.1' },
          { regex: /windows nt 6.2/i, name: 'Windows 8' },
          { regex: /windows nt 6.1/i, name: 'Windows 7' },
          { regex: /windows nt 6.0/i, name: 'Windows Vista' },
          { regex: /windows nt 5.2/i, name: 'Windows Server 2003/XP x64' },
          { regex: /windows nt 5.1/i, name: 'Windows XP' },
          { regex: /windows xp/i, name: 'Windows XP' },
          { regex: /windows nt 5.0/i, name: 'Windows 2000' },
          { regex: /windows me/i, name: 'Windows ME' },
          { regex: /win98/i, name: 'Windows 98' },
          { regex: /win95/i, name: 'Windows 95' },
          { regex: /win16/i, name: 'Windows 3.11' },
          { regex: /macintosh|mac os x/i, name: 'Mac OS X' },
          { regex: /mac_powerpc/i, name: 'Mac OS 9' },
          { regex: /linux/i, name: 'Linux' },
          { regex: /ubuntu/i, name: 'Ubuntu' },
          { regex: /iphone/i, name: 'iPhone' },
          { regex: /ipod/i, name: 'iPod' },
          { regex: /ipad/i, name: 'iPad' },
          { regex: /android/i, name: 'Android' },
          { regex: /blackberry/i, name: 'BlackBerry' },
          { regex: /webos/i, name: 'Mobile' }
        ];
      
        for (const os of osArray) {
          if (os.regex.test(userAgent)) {
            osPlatform = os.name;
            break;
          }
        }
      
        return osPlatform;
      };

      const getSystemProtocol = (req) => {
        const isSecure =
          req.secure || // True if using HTTPS
          (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] === 'https') ||
          (req.headers['x-forwarded-ssl'] && req.headers['x-forwarded-ssl'] === 'on');
      
        return isSecure ? 'https' : 'http';
      };
      
      
  
  

    module.exports = {
        getHashKey,
        getDateTime,
        getClientIP,
        isValidURL,
        getHashToken,
        getUserBrowser,
        getUserOS,
        getSystemProtocol
    };