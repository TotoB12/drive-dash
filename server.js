const express = require('express');
const path = require('path');
const app = express();

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Start the server on port 3000
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Drive Dash app is running at http://localhost:${PORT}`);
});
