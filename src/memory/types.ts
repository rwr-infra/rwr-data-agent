export interface ConversationSummary {
  summary: string;
  mentionedEntities: string[];
  currentTopic: string;
  turnCount: number;
  updatedAt: number;
}
