const express = require("express");
const path = require("path");
const controller = require("./controller");
const router = new express.Router();

router.get("", async (req, res, next) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

router.post("/data", async (req, res, next) => {
  res.setHeader("Content-Type", "application/json");
  try {
    await controller.getData(req, res);
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      res.destroy(err);
    }
  }
});

module.exports = router;
