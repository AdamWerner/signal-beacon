import Avanza from 'avanza';
import { AvanzaCredentials, AvanzaInstrument, AvanzaSearchResult } from './types.js';
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
  async searchCertificates(query: string): Promise<AvanzaInstrument[]> {
    return this.searchCertificatesInternal(query, true);
  }

  private async searchCertificatesInternal(
    query: string,
    allowReauthRetry: boolean
  ): Promise<AvanzaInstrument[]> {
    if (!this.authenticated) {
      await this.authenticate();
    }

    try {
      // Important: avanza.search expects only a query argument (no `{ limit }` object).
      const results = await this.avanza.search(query) as AvanzaSearchResult | unknown;
      const instruments = this.extractCertificatesFromSearch(results);
      if (instruments.length > 0) {
        return instruments.filter(instrument => isValidCertificate(instrument.name, instrument.tradable));
      }

      // Fallback for API payload shape/endpoint differences.
      return this.searchCertificatesViaFilteredEndpoint(query);
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

        return this.searchCertificatesInternal(query, false);
      }

      if (`${error?.message || ''}`.includes('404') || `${error?.message || ''}`.includes('search')) {
        try {
          return await this.searchCertificatesViaFilteredEndpoint(query);
        } catch (fallbackError) {
          console.error(`Fallback filtered search failed for query "${query}":`, fallbackError);
          return [];
        }
      }

      console.error(`Search failed for query "${query}":`, error);
      return [];
    }
  }

  private extractCertificatesFromSearch(results: unknown): AvanzaInstrument[] {
    const parsed = results as AvanzaSearchResult;
    if (!parsed || !Array.isArray(parsed.hits)) {
      return [];
    }

    const certificates: AvanzaInstrument[] = [];
    for (const hit of parsed.hits) {
      if (hit.instrumentType !== 'CERTIFICATE' || !Array.isArray(hit.topHits)) {
        continue;
      }

      for (const instrument of hit.topHits) {
        certificates.push(instrument);
      }
    }

    return certificates;
  }

  private async searchCertificatesViaFilteredEndpoint(query: string): Promise<AvanzaInstrument[]> {
    const securityToken = (this.avanza as any)._securityToken as string;
    const authSession = (this.avanza as any)._authenticationSession as string;

    const body = JSON.stringify({
      query,
      searchFilter: { types: ['CERTIFICATE'] },
      pagination: { from: 0, size: 100 }
    });

    const response = await fetch('https://www.avanza.se/_api/search/filtered-search', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-SecurityToken': securityToken,
        'X-AuthenticationSession': authSession
      },
      body
    });

    if (response.status === 401) {
      throw { statusCode: 401 };
    }

    if (!response.ok) {
      throw new Error(`Avanza filtered search returned ${response.status}`);
    }

    const data = await response.json() as { hits?: AvanzaInstrument[] };
    const instruments = data.hits ?? [];
    return instruments.filter(instrument => isValidCertificate(instrument.name, instrument.tradable));
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
