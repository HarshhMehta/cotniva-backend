const express = require("express");
const router = express.Router();
const { submitContact } = require("../controller/contact.controller");

router.post("/", submitContact);

module.exports = router;
