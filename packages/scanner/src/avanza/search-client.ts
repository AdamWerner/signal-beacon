import Avanza from 'avanza';
import { AvanzaCredentials, AvanzaSearchResult, AvanzaInstrument } from './types.js';
import { isValidCertificate } from './certificate-parser.js';

export class AvanzaSearchClient {
  private avanza: Avanza;
  private authenticated: boolean = false;
  private credentials: AvanzaCredentials;

  constructor(credentials: AvanzaCredentials) {
    this.avanza = new Avanza();
    this.credentials = credentials;
  }

  /**
   * Authenticate with Avanza. Must be called before searching.
   */
  async authenticate(): Promise<void> {
    if (this.authenticated) {
      return;
    }

    try {
      await this.avanza.authenticate({
        username: this.credentials.username,
        password: this.credentials.password,
        totpSecret: this.credentials.totpSecret
      });

      this.authenticated = true;
      console.log('✓ Authenticated with Avanza');
    } catch (error) {
      console.error('Failed to authenticate with Avanza:', error);
      throw new Error('Avanza authentication failed');
    }
  }

  /**
   * Search for certificates by query term
   */
  async searchCertificates(query: string, limit = 20): Promise<AvanzaInstrument[]> {
    if (!this.authenticated) {
      await this.authenticate();
    }

    try {
      const results = await this.avanza.search(query, { limit }) as AvanzaSearchResult;

      // Extract certificate hits
      const certificateHit = results.hits?.find(hit => hit.instrumentType === 'CERTIFICATE');

      if (!certificateHit) {
        return [];
      }

      // Filter for tradable bull/bear certificates only
      const validCertificates = certificateHit.topHits.filter(instrument =>
        isValidCertificate(instrument.name, instrument.tradable)
      );

      return validCertificates;
    } catch (error) {
      console.error(`Search failed for query "${query}":`, error);
      return [];
    }
  }

  /**
   * Search for all certificate variants of an underlying asset
   */
  async searchUnderlyingAsset(
    underlyingTerms: string[],
    direction?: 'bull' | 'bear'
  ): Promise<AvanzaInstrument[]> {
    const allResults: AvanzaInstrument[] = [];
    const seenIds = new Set<string>();

    for (const term of underlyingTerms) {
      const query = direction ? `${direction} ${term}` : term;

      const results = await this.searchCertificates(query);

      // Deduplicate by ID
      for (const result of results) {
        if (!seenIds.has(result.id)) {
          seenIds.add(result.id);
          allResults.push(result);
        }
      }

      // Rate limiting: wait 2 seconds between requests
      await this.delay(2000);
    }

    return allResults;
  }

  /**
   * Disconnect from Avanza
   */
  async disconnect(): Promise<void> {
    // The avanza library doesn't have an explicit disconnect method,
    // but we can reset the authentication flag
    this.authenticated = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create an authenticated Avanza client from environment variables
 */
export function createAvanzaClient(): AvanzaSearchClient {
  const credentials: AvanzaCredentials = {
    username: process.env.AVANZA_USERNAME || '',
    password: process.env.AVANZA_PASSWORD || '',
    totpSecret: process.env.AVANZA_TOTP_SECRET || undefined
  };

  if (!credentials.username || !credentials.password) {
    throw new Error('AVANZA_USERNAME and AVANZA_PASSWORD must be set in environment');
  }

  return new AvanzaSearchClient(credentials);
}
