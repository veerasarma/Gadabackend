const express = require('express');
const router = express.Router();
const { getInitialData } = require('../controllers/init.controller');
const attachSystem = require('../middlewares/attachSystem');
const attachUser = require('../middlewares/attachUser');

router.get('/init', attachSystem, attachUser, getInitialData);

module.exports = router;
