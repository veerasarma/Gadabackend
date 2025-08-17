const Hashids = require('hashids/cjs');
const hashids = new Hashids(process.env.HASHID_SALT, 10);  
// └── your secret, from .env, at least 10 chars
// └── minimum length of the resulting hash = 10

module.exports = {
  encodeId: (id) => hashids.encode(id),
  decodeId: (hash) => {
    const arr = hashids.decode(hash);
    if (!arr.length) throw new Error('Invalid ID');
    return arr[0];
  }
};