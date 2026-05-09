export interface Message {
  role: string;
  content: string;
}

export interface DisplayMessage {
  role: 'user' | 'ai' | 'error';
  content: string;
}

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
