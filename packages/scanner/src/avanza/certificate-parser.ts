import { ParsedCertificate } from './types.js';

/**
 * Parses Avanza certificate names into structured data.
 *
 * Expected formats:
 * - BULL SP500 X2 AVA 3
 * - BEAR OLJA X10 VON
 * - BULL BITCOIN AVA
 * - BEAR OMX X5
 */
export function parseCertificateName(avanza_id: string, name: string): ParsedCertificate | null {
  // Clean and normalize the name
  const cleaned = name.trim().toUpperCase();

  // Extract direction (BULL or BEAR)
  let direction: 'bull' | 'bear' | null = null;
  if (cleaned.startsWith('BULL ')) {
    direction = 'bull';
  } else if (cleaned.startsWith('BEAR ')) {
    direction = 'bear';
  } else {
    return null; // Not a bull/bear certificate
  }

  // Remove the direction prefix
  const rest = cleaned.replace(/^(BULL|BEAR)\s+/, '');

  // Pattern: [UNDERLYING] [Xn] [ISSUER] [SERIES]
  // Examples:
  // SP500 X2 AVA 3
  // OLJA X10 VON
  // BITCOIN AVA
  // OMX X5

  const parts = rest.split(/\s+/);
  if (parts.length === 0) {
    return null;
  }

  const underlying = parts[0];
  let leverage: number | null = null;
  let issuer: string | null = null;
  let series: string | null = null;

  // Look for leverage (X2, X5, X10, etc.)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];

    if (part.startsWith('X') && part.length > 1) {
      const levNum = parseInt(part.substring(1), 10);
      if (!isNaN(levNum)) {
        leverage = levNum;
        continue;
      }
    }

    // Common issuers
    const knownIssuers = ['AVA', 'NORDNET', 'VON', 'SG', '21SHARES', 'VALOUR', 'SHB', 'HANDELSBANKEN'];
    if (knownIssuers.includes(part)) {
      issuer = part;
      continue;
    }

    // If it's a number and we already have an issuer, it's likely a series
    if (!isNaN(parseInt(part, 10)) && issuer) {
      series = part;
    }
  }

  return {
    avanza_id,
    name,
    direction,
    underlying,
    leverage,
    issuer,
    series
  };
}

/**
 * Generates an Avanza URL for the certificate
 */
export function generateInstrumentUrl(avanza_id: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');

  return `https://www.avanza.se/borshandlade-produkter/certifikat-torg/om-certifikatet.html/${avanza_id}/${slug}`;
}

/**
 * Validates if an instrument is a tradable bull/bear certificate
 */
export function isValidCertificate(name: string, tradable: boolean): boolean {
  if (!tradable) return false;

  const upper = name.toUpperCase();
  return upper.startsWith('BULL ') || upper.startsWith('BEAR ');
}
