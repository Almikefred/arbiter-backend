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

app.use(express.json());
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

// POST /oracle/batch — accept an array of { question, tier, category } items
// and process each through the same single-question path, but consume the
// rate-limit budget once for the whole batch (dedicated oracleBatch bucket).
// Partial-success semantics: each item reports its own result/error so one
// malformed item never drops or mis-attributes the others.
app.post('/oracle/batch', async (req, res) => {
  const config = require('./config');
  const { rateLimited } = require('./rateLimit');
  const oracle = require('./oracle');

  const items = req.body && Array.isArray(req.body.questions) ? req.body.questions : null;
  if (!items) {
    return res.status(400).json({ error: 'body.questions must be an array' });
  }

  const maxBatch = (config.rateLimits && config.rateLimits.oracleBatch && config.rateLimits.oracleBatch.maxItems) || 50;
  if (items.length === 0) {
    return res.status(400).json({ error: 'questions array must not be empty' });
  }
  if (items.length > maxBatch) {
    return res.status(400).json({ error: `batch size ${items.length} exceeds max ${maxBatch}` });
  }

  // One rate-limit consumption for the whole batch.
  const limiter = rateLimited('oracleBatch', (r) => r.ip);
  return limiter(req, res, async () => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item.question !== 'string' || item.question.length === 0) {
        results.push({ index: i, ok: false, error: 'missing question' });
        continue;
      }
      if (config.maxQuestionLength && item.question.length > config.maxQuestionLength) {
        results.push({ index: i, ok: false, error: 'question too long' });
        continue;
      }
      try {
        const result = await oracle.issueChallengeIdempotent({
          question: item.question,
          tier: item.tier,
          category: item.category,
          req,
        });
        results.push({ index: i, ok: true, result });
      } catch (err) {
        results.push({ index: i, ok: false, error: err && err.message ? err.message : 'failed' });
      }
    }
    return res.json({ results });
  });
});

async function start() {
  await rebuildSubscribedWorkers();
  const port = process.env.PORT || 3000;
  const server = http.createServer(app);
  attachWebSocketServer(server);
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });

  // Start the gRPC interface alongside Express in the same process. It binds
  // to its own port (GRPC_PORT, default 50051) so there are no port or route
  // conflicts, and shares oracle.js's business logic rather than duplicating it.
  try {
    const oracle = require('./oracle');
    const { startGrpcServer } = require('./grpc-server');
    await startGrpcServer(oracle);
  } catch (err) {
    console.error('Failed to start gRPC server:', err);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
module.exports.attachWebSocketServer = attachWebSocketServer;
