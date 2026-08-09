import { z } from "zod";
const responseSchema = z.object({
  data: z.array(
    z.object({
      index: z.number().int(),
      embedding: z.array(z.number().finite()).min(8),
    }),
  ),
});
export async function embedTexts(texts: string[]) {
  if (!texts.length) return [];
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY must be configured");
  const model = process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small";
  const response = await fetch(
    `${(process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: texts, encoding_format: "float" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(`Embedding provider returned ${response.status}`);
  const parsed = responseSchema.parse(await response.json());
  const sorted = [...parsed.data].sort((a, b) => a.index - b.index);
  if (sorted.length !== texts.length)
    throw new Error("Embedding provider returned an incomplete batch");
  return sorted.map((item) => ({ embedding: item.embedding, model }));
}
export function cosine(left: number[], right: number[]) {
  if (left.length !== right.length || !left.length) return -1;
  let dot = 0,
    a = 0,
    b = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    a += left[index]! ** 2;
    b += right[index]! ** 2;
  }
  return a && b ? dot / (Math.sqrt(a) * Math.sqrt(b)) : -1;
}
