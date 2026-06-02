export type DocumentType = 'weapon' | 'soldier' | 'faction' | 'script_chunk' | 'projectile' | 'vehicle' | 'call' | 'character' | 'carry_item' | 'resource';

export interface LanguageData {
  language: string;
  translations: Record<string, string>;
}

export interface StructuredDocument {
  type: DocumentType;
  key: string;
  label: string;
  source_file: string;
  mod_name: string;
  description: string;
  raw_text: string;
  data: unknown;
  flat_attributes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  i18n?: Record<string, Record<string, string>>;
}

export interface RWRDocument {
  doc_id: string;
  type: DocumentType;
  key: string;
  content: string;
  metadata: {
    faction?: string;
    mod_name: string;
    weapon_class?: string;
    file_path: string;
    [key: string]: unknown;
  };
}

export interface SearchFilters {
  type?: DocumentType;
  faction?: string;
  mod_name?: string;
  weapon_class?: string;
  [key: string]: string | undefined;
}

export interface SearchResult {
  doc_id: string;
  type: DocumentType;
  key: string;
  content: string;
  metadata: RWRDocument['metadata'];
  /**
   * Legacy ordering field with overloaded meaning per route (vector cosine
   * distance, -fts_rank, -rrf_score, or 0.0 for exact lookups). Lower = better.
   * Prefer `score` for relevance once rerank has run.
   */
  distance: number;
  /** Reranker relevance score in [0,1], set after rerank; undefined beforehand. Higher = better. */
  score?: number;
  /** Retrieval route(s) that surfaced this result (e.g. 'vector', 'fts', 'ilike', 'alias'). */
  source?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  table?: string;
  response_format?: { type: 'json_object' | 'text' };
}
