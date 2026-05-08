import type { RWRDocument } from '../types/index.js';

const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

/**
 * Split long documents into overlapping chunks for better embedding quality.
 * Short documents (≤ CHUNK_SIZE chars) are returned unchanged.
 * Each chunk preserves the parent document's type, key, and metadata,
 * with a chunk index appended to the key.
 */
export function chunkDocuments(docs: RWRDocument[]): RWRDocument[] {
  const result: RWRDocument[] = [];

  for (const doc of docs) {
    if (doc.content.length <= CHUNK_SIZE) {
      result.push(doc);
      continue;
    }

    const chunks = splitContent(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);

    if (chunks.length === 1) {
      result.push(doc);
      continue;
    }

    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const chunkContent = isFirst
        ? chunks[i]
        : `[...continuation of ${doc.type}: ${doc.key}]\n${chunks[i]}`;

      result.push({
        ...doc,
        doc_id: '',
        key: i === 0 ? doc.key : `${doc.key}__chunk_${i + 1}`,
        content: chunkContent,
        metadata: {
          ...doc.metadata,
          chunk_index: i + 1,
          chunk_total: chunks.length,
          parent_key: doc.key,
        },
      });
    }
  }

  return result;
}

function splitContent(content: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < content.length) {
    let end = start + chunkSize;

    if (end >= content.length) {
      chunks.push(content.slice(start));
      break;
    }

    const newlinePos = content.lastIndexOf('\n', end);
    const doubleNewlinePos = content.lastIndexOf('\n\n', end);

    if (doubleNewlinePos > start + chunkSize * 0.5) {
      end = doubleNewlinePos;
    } else if (newlinePos > start + chunkSize * 0.5) {
      end = newlinePos;
    }

    chunks.push(content.slice(start, end));
    const nextStart = end - overlap;
    start = nextStart > start ? nextStart : end;
  }

  return chunks;
}