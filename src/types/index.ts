export type DocumentType = 'weapon' | 'soldier' | 'faction' | 'script_chunk' | 'projectile' | 'vehicle';

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
  distance: number;
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
}
