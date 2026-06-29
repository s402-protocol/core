export const summarizeTool = {
  name: 'summarize',
  description: 'Summarize a document to a single sentence. Payment-gated.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The document to summarize.' }
    },
    required: ['text']
  }
} as const;

export function summarize(text: string): string {
  const firstSentence = text.split(/[.!?]\s/)[0] ?? text;
  return `${firstSentence.slice(0, 200).trim()}...`;
}
