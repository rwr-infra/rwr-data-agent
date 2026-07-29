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

export type ScriptSymbolKind =
  | 'function'
  | 'class'
  | 'include'
  | 'hook'
  | 'enum'
  | 'namespace'
  | 'funcdef'
  | 'property';

export interface ScriptSymbol {
  file: string;
  name: string;
  signature: string;
  kind: ScriptSymbolKind;
  line: number;
  /** Enclosing class/namespace, when the symbol is a member. */
  parent?: string;
}

export interface GraphPackage {
  name: string;
  displayName: string;
}

export interface RwrGraph {
  version: number;
  /** Packages discovered under `source_dir`; every node's `mod` is one of these names. */
  packages: GraphPackage[];
  source_dir: string;
  built_at: string;
  stats: { nodes: number; edges: number; files: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
}
