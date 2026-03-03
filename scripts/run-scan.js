#!/usr/bin/env node

import 'dotenv/config';
import { scanner } from '@polysignal/scanner';

console.log('Running manual scan cycle...\n');

try {
  const result = await scanner.runScanCycle();

  console.log('\n=== Scan Results ===');
  console.log(`Markets tracked: ${result.marketsTracked}`);
  console.log(`Odds changes detected: ${result.oddsChangesDetected}`);
  console.log(`Whales detected: ${result.whalesDetected}`);
  console.log(`Signals generated: ${result.signalsGenerated}`);
  console.log(`Alerts sent: ${result.alertsSent}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

  process.exit(0);
} catch (error) {
  console.error('Scan failed:', error);
  process.exit(1);
}
