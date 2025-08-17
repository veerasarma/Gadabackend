const { UAParser } = require('ua-parser-js');
const requestIp = require('request-ip');

function getClientIp(req) {
  // request-ip checks X-Forwarded-For, CF-Connecting-IP, etc.
  const ip = requestIp.getClientIp(req);
  return ip || null; // can be "::ffff:127.0.0.1" etc.
}

function parseUserAgent(userAgent) {
  const parser = new UAParser(userAgent || '');
  const r = parser.getResult();
  return {
    userAgent: userAgent || '',
    browserName: r.browser.name || null,
    browserVersion: r.browser.version || null,
    osName: r.os.name || null,
    osVersion: r.os.version || null,
    deviceType: r.device.type || 'desktop', // ua-parser returns undefined on desktops
  };
}

module.exports = { getClientIp, parseUserAgent };
