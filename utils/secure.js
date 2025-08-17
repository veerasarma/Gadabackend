async function secureUserObject(user) {
    const disallowedValues = [
      'user_email_verification_code',
      'user_phone_verification_code',
      'user_two_factor_key',
      'user_two_factor_gsecret',
      'user_reset_key',
      'user_password',
      'session_token',
      'active_session_token',
    ];
  
    const data = user._data || user;
  
    const filteredUser = Object.keys(data).reduce((result, key) => {
      if (!disallowedValues.includes(key)) {
        result[key] = data[key];
      }
      return result;
    }, {});
  
    return filteredUser;
  }

  const htmlEntities = (str) => {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  
  // Helper to check if a value is empty
  const isEmpty = (val) => {
    return val === undefined || val === null || val === '';
  };
  
  // Optional: implement setDatetime conversion logic
  const setDatetime = (val) => {
    const d = new Date(val);
    return d.toISOString().slice(0, 19).replace('T', ' '); // MySQL datetime format
  };
  
  /**
   * Secure the input value similar to PHP's `secure()` function.
   * 
   * @param {*} value - The value to secure.
   * @param {string} type - 'int', 'float', 'datetime', 'search', or ''.
   * @param {boolean} quoted - Whether to return value as SQL string.
   * @returns {*} - Safe value, ready for SQL or other usage.
   */
  const secure = (value, type = '', quoted = true) => {
    if (value === 'null') return value;
  
    // 1. Convert HTML entities
    value = htmlEntities(String(value));
  
    // 2. Sanitize based on type
    switch (type) {
      case 'int':
        value = parseInt(value, 10) || 0;
        return quoted ? `'${value}'` : value;
  
      case 'float':
        value = parseFloat(value) || 0.0;
        return quoted ? `'${value}'` : value;
  
      case 'datetime':
        value = setDatetime(value);
        return quoted ? `'${value}'` : value;
  
      case 'search':
        if (!isEmpty(value)) {
          return quoted ? `'%${value}%'` : `%${value}%`;
        }
        return quoted ? `''` : '';
  
      default:
        value = isEmpty(value) ? '' : value;
        return quoted ? `'${value}'` : value;
    }
  };
  

  module.exports = {
    secureUserObject,
    secure
  };