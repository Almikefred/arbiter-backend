const express = require('express');
const helmet = require('helmet');
const path = require('path');
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

// Worker practice mode: a self-contained sandbox for prospective workers to
// practice the answer-submission flow without touching real dispatch state.
// Mirrors sandbox.js's discipline for the payer side: structurally identical
// response shapes, a `sandbox: true` flag, and never touching the chain.
//
// Isolation guarantees:
//   - Never imports or mutates dispatch.js's `collectors` Map.
//   - Never calls resolveQuestion/refundQuestion or any stellarClient.js fn.
//   - Never calls reconcile().
//   - Uses its own in-memory practice sessions keyed by workerId.
const PRACTICE_QUESTIONS = [
  {
    id: 'practice-1',
    prompt: 'What is the capital of France?',
    expectedAnswer: 'Paris',
  },
  {
    id: 'practice-2',
    prompt: 'What is 2 + 2?',
    expectedAnswer: '4',
  },
  {
    id: 'practice-3',
    prompt: 'Which planet is known as the Red Planet?',
    expectedAnswer: 'Mars',
  },
];

// workerId -> { question, answered }
const practiceSessions = new Map();

function normalizeAnswer(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase();
}

// Opt-in: a worker connects with `?practice=true` and immediately receives a
// synthetic `question` event shaped like a real SSE dispatch payload.
app.get('/app/events', (req, res) => {
  if (req.query.practice !== 'true') {
    res.status(400).json({
      error:
        'Practice mode requires ?practice=true. Real dispatch SSE is handled elsewhere.',
    });
    return;
  }

  const workerId = req.query.workerId;
  if (!workerId) {
    res.status(400).json({ error: 'workerId is required for practice mode' });
    return;
  }

  const question =
    PRACTICE_QUESTIONS[Math.floor(Math.random() * PRACTICE_QUESTIONS.length)];
  practiceSessions.set(workerId, { question, answered: false });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Same `event: <name>\ndata: <json>\n\n` shape dispatch.js's writeSse emits.
  const payload = {
    id: question.id,
    prompt: question.prompt,
    sandbox: true,
    practice: true,
  };
  res.write(`event: question\ndata: ${JSON.stringify(payload)}\n\n`);

  req.on('close', () => {
    res.end();
  });
});

// Accept a practice answer and return canned feedback. Never touches real
// dispatch collector state or the chain.
app.post('/app/answer', express.json(), (req, res) => {
  const body = req.body || {};
  if (body.practice !== true) {
    res.status(400).json({
      error:
        'Practice mode requires practice: true. Real answer submission is handled elsewhere.',
    });
    return;
  }

  const workerId = body.workerId;
  if (!workerId) {
    res.status(400).json({ error: 'workerId is required for practice mode' });
    return;
  }

  const session = practiceSessions.get(workerId);
  if (!session) {
    res.status(400).json({
      error: 'No active practice session. Connect to /app/events?practice=true first.',
    });
    return;
  }

  const matchedConsensus =
    normalizeAnswer(body.answer) === normalizeAnswer(session.question.expectedAnswer);
  session.answered = true;

  res.json({
    sandbox: true,
    practice: true,
    questionId: session.question.id,
    matchedConsensus,
    feedback: matchedConsensus
      ? 'Correct — your answer matches the expected consensus.'
      : 'Not quite — your answer does not match the expected consensus.',
  });
});

// Rebuild the in-process push subscribed-workers index from durable store
// records on startup, so getPushEligibleWorkerIds() works before any worker
// re-calls the subscribe endpoint after a restart.
const { rebuildSubscribedWorkers } = require('./push');

async function start() {
  await rebuildSubscribedWorkers();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
