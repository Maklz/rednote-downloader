import Anthropic from '@anthropic-ai/sdk';

const TRANSLATION_MODEL = 'claude-opus-5';
const TRANSLATION_MAX_TOKENS = 2000;

// Captions are short and the task is mechanical, so the cheapest effort level
// is the right one here -- higher effort buys nothing on a few lines of text.
const TRANSLATION_EFFORT = 'low';

const SYSTEM_PROMPT = [
  'You translate social media captions into Russian.',
  'Return only the translation, with no preamble, notes, or quotation marks around it.',
  'Keep the original line breaks and the order of the lines.',
  'Leave URLs, @handles, hashtags, emoji, and numbers exactly as they are.',
  'Text already in Russian stays as it is.',
].join(' ');

export function isTranslationConfigured(config) {
  return Boolean(config?.enabled && config?.apiKey);
}

/**
 * Translates a caption into Russian. Returns the original text unchanged when
 * translation is switched off, when there is nothing to translate, or when the
 * API call fails -- publishing the untranslated post beats publishing nothing.
 */
export async function translateCaption(text, config, options = {}) {
  const source = String(text || '').trim();

  if (!source || !isTranslationConfigured(config)) {
    return { text: source, translated: false };
  }

  const client = options.client || new Anthropic({ apiKey: config.apiKey });

  try {
    const response = await client.messages.create({
      model: config.model || TRANSLATION_MODEL,
      max_tokens: TRANSLATION_MAX_TOKENS,
      output_config: { effort: TRANSLATION_EFFORT },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: source }],
    });

    if (response.stop_reason === 'refusal') {
      return { text: source, translated: false, error: 'translation refused' };
    }

    const translated = (response.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (!translated) {
      return { text: source, translated: false, error: 'empty translation' };
    }

    return { text: translated, translated: true };
  } catch (error) {
    return {
      text: source,
      translated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
