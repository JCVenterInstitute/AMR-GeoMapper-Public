// server.js
const express = require("express");
const path = require("path");
const app = express();
require("dotenv").config();
const PORT = process.env.PORT || 3000;
const route = require("./express/route");

// Middleware: parse JSON requests if needed
app.use(express.json());

app.set("etag", "strong");

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, "public")));
app.use("/", route);

// Start the server
app.listen(PORT, () => {
  console.log(`Development server running on http://localhost:${PORT}`);
});
