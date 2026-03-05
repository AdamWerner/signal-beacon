import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { scanner } from '@polysignal/scanner';
import { errorHandler } from './middleware/error-handler.js';

// Import routes
import signalsRouter from './routes/signals.js';
import marketsRouter from './routes/markets.js';
import instrumentsRouter from './routes/instruments.js';
import correlationsRouter from './routes/correlations.js';
import ontologyRouter from './routes/ontology.js';
import whalesRouter from './routes/whales.js';
import healthRouter from './routes/health.js';
import briefingRouter from './routes/briefing.js';
import tweetsRouter from './routes/tweets.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3100', 10);

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/signals', signalsRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/instruments', instrumentsRouter);
app.use('/api/correlations', correlationsRouter);
app.use('/api/ontology', ontologyRouter);
app.use('/api/whales', whalesRouter);
app.use('/api/health', healthRouter);
app.use('/api/briefing', briefingRouter);
app.use('/api/tweets', tweetsRouter);

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'PolySignal API',
    version: '1.0.0',
    endpoints: [
      '/api/signals',
      '/api/markets',
      '/api/instruments',
      '/api/correlations',
      '/api/ontology',
      '/api/whales',
      '/api/health',
      '/api/briefing/:market',
      '/api/tweets'
    ]
  });
});

// Error handler
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`\n✓ PolySignal API server running on http://localhost:${PORT}`);
  console.log(`✓ Health check: http://localhost:${PORT}/api/health`);
  console.log('\nStarting scanner...\n');

  // Start the scanner
  scanner.start();
});

export { app };
