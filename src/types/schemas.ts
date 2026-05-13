import { z } from 'zod';

export const EnumItemSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  summary: z.string(),
});

export const EnumResultSchema = z.object({
  items: z.array(EnumItemSchema),
  total: z.number(),
});

export const ComparisonItemSchema = z.object({
  key: z.string(),
  name: z.string(),
  attributes: z.record(z.string(), z.string()),
});

export const ComparisonResultSchema = z.object({
  items: z.array(ComparisonItemSchema),
  comparison: z.string(),
});

export type EnumResult = z.infer<typeof EnumResultSchema>;
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
