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

// Serve the built frontend from this process by default (local/demo usage).
// Set SERVE_STATIC_APP=false when a CDN/Vercel deployment fronts the app build
// so static-asset traffic never enters this process's request chain.
const serveStaticApp = process.env.SERVE_STATIC_APP !== 'false';
if (serveStaticApp) {
  app.use(express.static(path.join(__dirname, 'dist')));
}

// GraphQL API mounted alongside the existing REST routes. Resolvers call the
// same underlying functions the REST handlers use (admin.js / payerIndex.js)
// rather than reimplementing data access. Auth is enforced per-resolver since
// GraphQL does not route through Express middleware per-field.
const { graphqlHTTP } = require('express-graphql');
const { buildSchema } = require('graphql');
const {
  listTransactions,
  listWorkers,
  listPayers,
  getTreasury,
  getFeeRevenue,
} = require('./admin');
const { getPayerQuestionIds, summarizePayerQuestions } = require('./payerIndex');
const { requireAdmin } = require('./adminAuth');
const { verifySessionToken } = require('./workerAuth');

const graphqlSchema = buildSchema(`
  type Transaction {
    id: String
    amount: String
    status: String
  }

  type Worker {
    address: String
    status: String
  }

  type Payer {
    address: String
  }

  type Treasury {
    balance: String
  }

  type FeeRevenue {
    amount: String
  }

  type PayerQuestion {
    id: String
    summary: String
  }

  type PayerQuestions {
    address: String
    questionIds: [String]
    questions: [PayerQuestion]
  }

  type Query {
    transactions: [Transaction]
    workers: [Worker]
    payers: [Payer]
    treasury: Treasury
    feeRevenue: FeeRevenue
    payerQuestions(address: String!): PayerQuestions
  }
`);

// Resolver-level admin guard: mirrors requireAdmin's 401/403 rejection by
// throwing a GraphQL error with an HTTP status code instead of returning null.
function assertAdmin(context) {
  return new Promise((resolve, reject) => {
    const req = context.req;
    const res = {
      status(code) {
        const err = new Error(
          code === 401 ? 'Unauthorized' : 'Forbidden'
        );
        err.statusCode = code;
        reject(err);
        return this;
      },
      json() {
        resolve();
        return this;
      },
      send() {
        resolve();
        return this;
      },
    };
    try {
      requireAdmin(req, res, () => resolve());
    } catch (err) {
      reject(err);
    }
  });
}

// Resolver-level payer guard: reuses verifySessionToken for payer-scoped
// fields, rejecting with 401 when the session token is missing or invalid.
function assertPayerSession(context, address) {
  const req = context.req;
  const token =
    (req.headers && req.headers.authorization
      ? String(req.headers.authorization).replace(/^Bearer\s+/i, '')
      : null) || (req.query && req.query.token) || null;
  const session = token ? verifySessionToken(token) : null;
  if (!session) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const sessionAddress = session.address || session.payer || session.sub;
  if (address && sessionAddress && sessionAddress !== address) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  return session;
}

const graphqlRoot = {
  transactions: async (args, context) => {
    await assertAdmin(context);
    return listTransactions();
  },
  workers: async (args, context) => {
    await assertAdmin(context);
    return listWorkers();
  },
  payers: async (args, context) => {
    await assertAdmin(context);
    return listPayers();
  },
  treasury: async (args, context) => {
    await assertAdmin(context);
    return getTreasury();
  },
  feeRevenue: async (args, context) => {
    await assertAdmin(context);
    return getFeeRevenue();
  },
  payerQuestions: async ({ address }, context) => {
    assertPayerSession(context, address);
    const questionIds = await getPayerQuestionIds(address);
    const questions = await summarizePayerQuestions(address);
    return { address, questionIds, questions };
  },
};

app.use(
  '/graphql',
  graphqlHTTP((req) => ({
    schema: graphqlSchema,
    rootValue: graphqlRoot,
    context: { req },
    graphiql: false,
    customFormatErrorFn: (err) => ({
      message: err.message,
      statusCode: err.statusCode || (err.originalError && err.originalError.statusCode),
    }),
  }))
);

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
