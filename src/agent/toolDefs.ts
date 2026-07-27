import { tool } from 'ai';
import { z } from 'zod';
import { config } from '../config/index.js';
import {
  configureGraph,
  getInheritanceChain,
  findReferences,
  getTransformChain,
  readSource,
  listFiles,
  getScriptSymbols,
  getNode,
} from './tools.js';

let configured = false;

export function initGraphTools(): void {
  if (configured) return;
  configureGraph(config.dataDir, config.graphPath);
  configured = true;
}

export function buildAgentTools() {
  initGraphTools();

  return {
    getInheritanceChain: tool({
      description:
        'Trace the full inheritance chain of an entity (weapon, carry_item, etc.). ' +
        'Returns parent chain (what this entity inherits from via file= attribute) ' +
        'and children (what inherits from this entity). Use when the user asks about ' +
        'inheritance, base files, parent templates, or "inherits from".',
      inputSchema: z.object({
        key: z.string().describe('The entity key (e.g., "m4a1.weapon", "K309.carry_item")'),
      }),
      execute: async ({ key }) => getInheritanceChain(key),
    }),

    findReferences: tool({
      description:
        'Find all entities that reference a given entity (reverse lookup). ' +
        'Shows who points TO this entity via extends, fires, transforms_to, etc. ' +
        'Use to answer "who uses this projectile", "which weapons reference this base".',
      inputSchema: z.object({
        key: z.string().describe('The entity key to find references for'),
      }),
      execute: async ({ key }) => findReferences(key),
    }),

    getTransformChain: tool({
      description:
        'Trace the degradation/consumption chain of a carry item (e.g., armor layers). ' +
        'Items with transform_on_consume transform into another item when consumed. ' +
        'Use to answer "how many armor layers does X have" or trace armor degradation.',
      inputSchema: z.object({
        key: z.string().describe('The carry item key (e.g., "K309.carry_item")'),
      }),
      execute: async ({ key }) => getTransformChain(key),
    }),

    readSource: tool({
      description:
        'Read the raw source file content. Use to inspect exact XML attributes, ' +
        'verify data, or read AngelScript source code. ' +
        'Supports optional line range for large files.',
      inputSchema: z.object({
        file: z.string().describe('Relative file path (e.g., "weapons/m4a1.weapon")'),
        startLine: z.number().optional().describe('Start line (1-indexed)'),
        endLine: z.number().optional().describe('End line (1-indexed)'),
      }),
      execute: async ({ file, startLine, endLine }) =>
        readSource(file, startLine, endLine),
    }),

    listFiles: tool({
      description:
        'List indexed files matching a glob pattern. Use to find files by name ' +
        'when you do not know the exact key. Supports optional type filter. ' +
        'Patterns use * as wildcard (e.g., "*m4*", "*.weapon").',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern (e.g., "*m4*", "*.call")'),
        type: z
          .string()
          .optional()
          .describe('Filter by node type (weapon, carry_item, projectile, call, etc.)'),
      }),
      execute: async ({ pattern, type }) => listFiles(pattern, type, 30),
    }),

    getScriptSymbols: tool({
      description:
        'Get parsed AngelScript (.as) function/class/include signatures with line numbers. ' +
        'Use to answer questions about game scripts, custom game modes, hooks, or mod logic. ' +
        'Much better than reading the full script file for "what functions exist".',
      inputSchema: z.object({
        file: z.string().describe('Relative .as file path (e.g., "scripts/start_1.as")'),
      }),
      execute: async ({ file }) => getScriptSymbols(file),
    }),

    getNode: tool({
      description:
        'Look up a single entity by its key. Returns basic info (type, file path, mod). ' +
        'Use to resolve a key to its source file before calling readSource, ' +
        'or to verify an entity exists.',
      inputSchema: z.object({
        key: z.string().describe('The entity key to look up'),
      }),
      execute: async ({ key }) => getNode(key),
    }),
  };
}
