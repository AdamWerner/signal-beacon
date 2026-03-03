export interface AvanzaSearchResult {
  hits: AvanzaSearchHit[];
  totalNumberOfHits: number;
}

export interface AvanzaSearchHit {
  instrumentType: string;
  numberOfHits: number;
  topHits: AvanzaInstrument[];
}

export interface AvanzaInstrument {
  id: string; // Avanza ID
  name: string;
  currency: string;
  lastPrice?: number;
  changePercent?: number;
  tradable: boolean;
  linkText: string;
  flagCode?: string;
}

export interface ParsedCertificate {
  avanza_id: string;
  name: string;
  direction: 'bull' | 'bear';
  underlying: string;
  leverage: number | null;
  issuer: string | null;
  series: string | null;
}

export interface AvanzaCredentials {
  username: string;
  password: string;
  totpSecret?: string;
}
