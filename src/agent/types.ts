export type EdgeRel =
  | 'extends'
  | 'fires'
  | 'transforms_to'
  | 'includes'
  | 'next_in_chain'
  | 'references';

export interface GraphNode {
  key: string;
  type: string;
  file: string;
  name?: string;
  mod: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: EdgeRel;
  context?: string;
}

export interface ScriptSymbol {
  file: string;
  name: string;
  signature: string;
  kind: 'function' | 'class' | 'include' | 'hook';
  line: number;
}

export interface RwrGraph {
  version: number;
  mod: string;
  source_dir: string;
  built_at: string;
  stats: { nodes: number; edges: number; files: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}
