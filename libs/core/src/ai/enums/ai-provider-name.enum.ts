/** The five supported AI provider families Crossmart can call. Stored on each connection and usage record. */
export enum AiProviderName {
  OpenAi = 'openai',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
  OpenAiCompatible = 'openai_compatible',
  AnthropicCompatible = 'anthropic_compatible',
}
