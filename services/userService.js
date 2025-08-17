
const {isValidURL} = require('../utils/helpers.js');


const verifyEmailFormat = (input) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(input);
  };
  
  const verifyUsernameFormat = (input) => {
    const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
    return usernameRegex.test(input);
  };

function validName(name, system) {
    // Disallow if special characters are disabled and name contains non-graphical or punct characters
    if (
      (!system.special_characters_enabled && !/^[\w\s]+$/.test(name)) ||
      (!system.special_characters_enabled && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(name)) ||
      isValidURL(name)
    ) {
      return false;
    }
    return true;
  }
  
  
  module.exports = {
    verifyEmailFormat,
    verifyUsernameFormat,
    validName
  };
  