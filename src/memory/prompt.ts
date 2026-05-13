export const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer for a game data assistant (Running With Rifles). Your job is to compress conversation history into a structured JSON summary used to improve search retrieval.

Rules:
- Output ONLY valid JSON, no markdown or explanation
- "summary": 1-2 sentence description of what the user is researching
- "entities": list of game item keys or names mentioned (e.g. "gkw_g36.weapon", "G36", "M4A1", "T14")
- "topic": single phrase describing current focus (e.g. "weapon-comparison", "vehicle-stats", "carry-item-lookup")
- "context": any disambiguation info needed (e.g. "user is comparing SMGs, specifically interested in magazine size")`;

export function buildSummaryPrompt(history: { role: string; content: string }[]): string {
  const conversation = history
    .slice(-10)
    .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
    .join('\n');

  return `Summarize this conversation into the required JSON format:\n\n${conversation}`;
}
