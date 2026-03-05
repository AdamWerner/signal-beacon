import Avanza from 'avanza';
import { AvanzaCredentials, AvanzaSearchResult, AvanzaInstrument } from './types.js';
import { isValidCertificate } from './certificate-parser.js';

export class AvanzaSearchClient {
  private avanza: Avanza;
  private authenticated = false;
  private credentials: AvanzaCredentials;

  constructor(credentials: AvanzaCredentials) {
    this.avanza = new Avanza();
    this.credentials = credentials;
  }

  /**
   * Authenticate with Avanza. Must be called before searching.
   * Retries up to 3 times with backoff: 5s, 10s, 15s.
   */
  async authenticate(): Promise<void> {
    if (this.authenticated) return;

    const backoffsMs = [5000, 10000, 15000];
    for (let attempt = 0; attempt < backoffsMs.length; attempt++) {
      try {
        await this.avanza.authenticate({
          username: this.credentials.username,
          password: this.credentials.password,
          totpSecret: this.credentials.totpSecret
        });

        this.authenticated = true;
        console.log(`Authenticated with Avanza (attempt ${attempt + 1})`);
        return;
      } catch (error) {
        const isLastAttempt = attempt === backoffsMs.length - 1;
        console.error(`Avanza auth attempt ${attempt + 1}/${backoffsMs.length} failed:`, error);

        if (isLastAttempt) {
          throw new Error(`Avanza authentication failed after ${backoffsMs.length} attempts`);
        }

        const delayMs = backoffsMs[attempt];
        console.log(`Retrying Avanza auth in ${delayMs / 1000}s...`);
        await this.delay(delayMs);
      }
    }
  }

  /**
   * Search for certificates by query term.
   * Re-authenticates once on 401 errors.
   */
  async searchCertificates(query: string, limit = 20): Promise<AvanzaInstrument[]> {
    return this.searchCertificatesInternal(query, limit, true);
  }

  private async searchCertificatesInternal(
    query: string,
    limit: number,
    allowReauthRetry: boolean
  ): Promise<AvanzaInstrument[]> {
    if (!this.authenticated) {
      await this.authenticate();
    }

    try {
      const results = await this.avanza.search(query, { limit }) as AvanzaSearchResult;
      const certificateHit = results.hits?.find(hit => hit.instrumentType === 'CERTIFICATE');

      if (!certificateHit) {
        return [];
      }

      return certificateHit.topHits.filter(instrument =>
        isValidCertificate(instrument.name, instrument.tradable)
      );
    } catch (error: any) {
      const isUnauthorized = error?.statusCode === 401 || `${error?.message || ''}`.includes('401');

      if (isUnauthorized && allowReauthRetry) {
        console.warn('Avanza session expired, re-authenticating and retrying search once...');
        this.authenticated = false;

        try {
          await this.authenticate();
        } catch (reauthError) {
          console.error('Avanza re-authentication failed:', reauthError);
          return [];
        }

        return this.searchCertificatesInternal(query, limit, false);
      }

      console.error(`Search failed for query "${query}":`, error);
      return [];
    }
  }

  /**
   * Search for all certificate variants of an underlying asset.
   */
  async searchUnderlyingAsset(
    underlyingTerms: string[],
    direction?: 'bull' | 'bear'
  ): Promise<AvanzaInstrument[]> {
    const allResults: AvanzaInstrument[] = [];
    const seenIds = new Set<string>();

    for (const term of underlyingTerms) {
      const queries = direction
        ? [`${direction} ${term}`]
        : [`bull ${term}`, `bear ${term}`];

      for (const query of queries) {
        const results = await this.searchCertificates(query);
        if (results.length === 0) {
          console.warn(`[avanza] no certificate hits for query "${query}"`);
        } else {
          console.log(`[avanza] query "${query}" -> ${results.length} candidate certificates`);
        }

        for (const result of results) {
          if (!seenIds.has(result.id)) {
            seenIds.add(result.id);
            allResults.push(result);
          }
        }

        await this.delay(2000);
      }
    }

    return allResults;
  }

  /**
   * Disconnect from Avanza.
   */
  async disconnect(): Promise<void> {
    this.authenticated = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create an authenticated Avanza client from environment variables.
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
