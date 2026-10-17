const express = require('express');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();

// Security headers: CSP, X-Frame-Options (frame-ancestors), nosniff, etc.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.static(path.join(__dirname, 'dist')));

// Rebuild the in-process push subscribed-workers index from durable store
// records on startup, so getPushEligibleWorkerIds() works before any worker
// re-calls the subscribe endpoint after a restart.
const { rebuildSubscribedWorkers } = require('./push');

// Attach a WebSocket dispatch transport to the same HTTP server that serves
// the SSE route (GET /app/events). Workers may connect over either transport;
// dispatch.js treats both uniformly via its transport-agnostic sendToWorker().
function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/app/ws' });
  wss.on('connection', (ws, req) => {
    const { registerWebSocketWorker } = require('./dispatch');
    registerWebSocketWorker(ws, req);
  });
  return wss;
}

async function start() {
  await rebuildSubscribedWorkers();
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  attachWebSocketServer(server);
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
module.exports.attachWebSocketServer = attachWebSocketServer;
