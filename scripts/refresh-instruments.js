#!/usr/bin/env node

import 'dotenv/config';
import { scanner } from '@polysignal/scanner';

console.log('Refreshing Avanza instruments registry...\n');

try {
  const result = await scanner.runInstrumentRefresh();

  console.log('\n=== Refresh Results ===');
  console.log(`Assets processed: ${result.assetsProcessed}`);
  console.log(`New instruments: ${result.instrumentsDiscovered}`);
  console.log(`Marked inactive: ${result.instrumentsMarkedInactive}`);
  console.log(`Total active: ${result.stats.total_active}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

  console.log('\nBy underlying asset:');
  Object.entries(result.stats.by_underlying).forEach(([underlying, counts]) => {
    console.log(`  ${underlying}: ${counts.bull} BULL, ${counts.bear} BEAR`);
  });

  process.exit(0);
} catch (error) {
  console.error('Refresh failed:', error);
  process.exit(1);
}
