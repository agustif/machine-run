import type { AiToolBackend, AiToolId } from "./Backend.ts";
import {
  AgentsBackend,
  ConfigAgentsBackend,
  ConfigCrushBackend,
  ConfigForgeBackend,
  ConfigGooseBackend,
  CopilotBackend,
  CursorBackend,
  GeminiBackend,
} from "./backends/Basic.ts";
import { ClaudeBackend } from "./backends/Claude.ts";
import { CodexBackend } from "./backends/Codex.ts";
import { GrokBackend } from "./backends/Grok.ts";
import { OpenCodeBackend } from "./backends/OpenCode.ts";

/**
 * The registry of AI tool backends, keyed by id — the same seam
 * `system-packages`' `packageManagerBackends` and `secrets`' `secretBackends`
 * use. `satisfies Record<AiToolId, AiToolBackend>` means every id in
 * {@link AiToolId} must have an entry here, checked at compile time rather
 * than discovered as a runtime "unknown tool" failure.
 */
export const aiToolBackends = {
  claude: ClaudeBackend,
  codex: CodexBackend,
  cursor: CursorBackend,
  gemini: GeminiBackend,
  grok: GrokBackend,
  copilot: CopilotBackend,
  agents: AgentsBackend,
  "config-agents": ConfigAgentsBackend,
  "config-crush": ConfigCrushBackend,
  "config-forge": ConfigForgeBackend,
  "config-goose": ConfigGooseBackend,
  "config-opencode": OpenCodeBackend,
} satisfies Record<AiToolId, AiToolBackend>;

export const aiToolBackend = (id: AiToolId): AiToolBackend => aiToolBackends[id];
