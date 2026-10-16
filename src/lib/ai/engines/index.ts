import "server-only";
import type { AiProviderId } from "@/lib/ai/catalog";
import { createAnthropicEngine } from "@/lib/ai/engines/anthropic";
import { createGeminiEngine } from "@/lib/ai/engines/gemini";
import { createOpenAiEngine } from "@/lib/ai/engines/openai";
import type { Engine } from "@/lib/ai/engines/types";

/** El motor de cada proveedor. Para sumar uno (Mistral, Grok...) basta un archivo nuevo aqui y su entrada en catalog.ts. */
export function engineFor(id: AiProviderId): Engine {
  switch (id) {
    case "anthropic":
      return createAnthropicEngine();
    case "openai":
      return createOpenAiEngine();
    case "gemini":
      return createGeminiEngine();
  }
}
