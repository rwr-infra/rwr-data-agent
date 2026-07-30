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
  /**
   * Package that owns the *referring* file. `from`/`to` are bare keys and 1300+ keys are
   * defined in more than one package, so without this an edge cannot be attributed and a
   * scoped traversal would merge every package that happens to share the key.
   * Optional so a graph built before version 3 still loads (unscoped, old behaviour).
   */
  mod?: string;
  /**
   * Package of the file the reference actually resolved to at build time. `to` is a bare key
   * and a base file like `base_valuable.carry_item` exists in several packages, so without
   * this a traversal has to guess which one the edge meant.
   */
  toMod?: string;
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
  /**
   * Owning package. `file` is a basename, so two packages shipping the same script name
   * collide without it. Stamped by the graph build; absent on the on-demand parse path.
   */
  mod?: string;
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
