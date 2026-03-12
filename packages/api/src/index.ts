import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { scanner } from '@polysignal/scanner';
import { errorHandler } from './middleware/error-handler.js';

import signalsRouter from './routes/signals.js';
import marketsRouter from './routes/markets.js';
import instrumentsRouter from './routes/instruments.js';
import correlationsRouter from './routes/correlations.js';
import ontologyRouter from './routes/ontology.js';
import whalesRouter from './routes/whales.js';
import healthRouter from './routes/health.js';
import briefingRouter from './routes/briefing.js';
import tweetsRouter from './routes/tweets.js';
import backtestRouter from './routes/backtest.js';
import streamingRouter from './routes/streaming.js';
import fusionRouter from './routes/fusion.js';

const app = express();
const PORT = parseInt(process.env.API_PORT || '3100', 10);
const START_SCANNER_IN_API = process.env.API_START_SCANNER === 'true';

app.use(cors());
app.use(express.json());

app.use('/api/signals', signalsRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/instruments', instrumentsRouter);
app.use('/api/correlations', correlationsRouter);
app.use('/api/ontology', ontologyRouter);
app.use('/api/whales', whalesRouter);
app.use('/api/health', healthRouter);
app.use('/api/briefing', briefingRouter);
app.use('/api/tweets', tweetsRouter);
app.use('/api/backtest', backtestRouter);
app.use('/api/streaming', streamingRouter);
app.use('/api/fusion', fusionRouter);

app.get('/', (_req, res) => {
  res.json({
    name: 'PolySignal API',
    version: '1.0.0',
    embedded_scanner: START_SCANNER_IN_API,
    endpoints: [
      '/api/signals',
      '/api/markets',
      '/api/instruments',
      '/api/correlations',
      '/api/ontology',
      '/api/whales',
      '/api/health',
      '/api/briefing/:market',
      '/api/tweets',
      '/api/backtest',
      '/api/streaming',
      '/api/fusion'
    ]
  });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`PolySignal API server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);

  if (START_SCANNER_IN_API) {
    console.log('API_START_SCANNER=true -> starting embedded scanner jobs in API process');
    scanner.start();
  } else {
    console.log('Embedded scanner disabled in API process (run npm run continuous separately).');
  }
});

export { app };
