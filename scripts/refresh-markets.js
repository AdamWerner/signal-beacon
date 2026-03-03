#!/usr/bin/env node

import 'dotenv/config';
import { scanner } from '@polysignal/scanner';

console.log('Refreshing Polymarket markets...\n');

try {
  const result = await scanner.runMarketRefresh();

  console.log('\n=== Refresh Results ===');
  console.log(`Total scanned: ${result.totalScanned}`);
  console.log(`New markets added: ${result.newMarketsAdded}`);
  console.log(`Markets updated: ${result.marketsUpdated}`);
  console.log(`Markets resolved: ${result.marketsResolved}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

  process.exit(0);
} catch (error) {
  console.error('Refresh failed:', error);
  process.exit(1);
}
