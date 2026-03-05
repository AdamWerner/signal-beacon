import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

interface AllowlistFile {
  known_persons: string[];
}

interface KnowledgeFile {
  person_to_asset: Record<string, string[]>;
  entity_to_asset: Record<string, string[]>;
  market_type_allowlist_keywords: string[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ALLOWLIST_PATH = join(__dirname, '../../../../data/entity-allowlist.json');
const KNOWLEDGE_PATH = join(__dirname, '../../../../data/entity-knowledge.json');

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function safeReadJson<T>(path: string, fallback: T): T {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export class KnowledgeBase {
  private allowlist = new Set<string>();
  private personToAsset = new Map<string, string[]>();
  private entityToAsset = new Map<string, string[]>();
  private allowlistedMarketKeywords: string[] = [];

  constructor() {
    const allowlistData = safeReadJson<AllowlistFile>(ALLOWLIST_PATH, { known_persons: [] });
    const knowledgeData = safeReadJson<KnowledgeFile>(KNOWLEDGE_PATH, {
      person_to_asset: {},
      entity_to_asset: {},
      market_type_allowlist_keywords: []
    });

    for (const person of allowlistData.known_persons) {
      this.allowlist.add(normalize(person));
    }

    for (const [person, assets] of Object.entries(knowledgeData.person_to_asset || {})) {
      this.personToAsset.set(normalize(person), assets);
    }

    for (const [entity, assets] of Object.entries(knowledgeData.entity_to_asset || {})) {
      this.entityToAsset.set(normalize(entity), assets);
    }

    this.allowlistedMarketKeywords = (knowledgeData.market_type_allowlist_keywords || []).map(normalize);
  }

  isKnownPerson(person: string): boolean {
    return this.allowlist.has(normalize(person)) || this.personToAsset.has(normalize(person));
  }

  personLinkedToAsset(person: string, assetId: string): boolean {
    const assets = this.personToAsset.get(normalize(person)) || [];
    return assets.includes(assetId);
  }

  entityLinkedToAsset(text: string, assetId: string): boolean {
    const lower = text.toLowerCase();
    for (const [entity, assets] of this.entityToAsset.entries()) {
      if (!assets.includes(assetId)) continue;
      if (lower.includes(entity)) return true;
    }
    return false;
  }

  isAllowlistedMarketType(text: string): boolean {
    const lower = text.toLowerCase();
    return this.allowlistedMarketKeywords.some(keyword => lower.includes(keyword));
  }
}
