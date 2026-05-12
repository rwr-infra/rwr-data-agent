export interface Message {
  role: string;
  content: string;
}

export type DisplayItem =
  | { type: 'message'; role: 'user' | 'ai' | 'error'; content: string; id: string }
  | { type: 'meta'; text: string; id: string };

export interface MetaInfo {
  ttfb: string | number;
  total: number;
  inTokens: string | number;
  outTokens: string | number;
}

export interface TableOption {
  value: string;
  label: string;
}