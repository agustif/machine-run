import * as Ai from "@machine-run/ai";
import * as Effect from "effect/Effect";

/**
 * `Ai.McpServer`, and the skill/config symlink compositions.
 *
 * These tools all store the same three things — skills, config, MCP servers —
 * in different places and different file formats, which is what the backend
 * seam exists to absorb. `vaultDir` holds the reviewed content under version
 * control; the resources here only link or register it.
 *
 * `aiSkill`/`aiConfig` symlink a directory you own, so the vault has to exist
 * and hold content you have actually read before these will do anything useful.
 */
export const ai = Effect.gen(function* () {
  const home = "~";
  const vaultDir = "~/machine-run/vault/ai";

  // A stdio MCP server: a binary this tool launches. `env` values can carry a
  // secret reference rather than a literal.
  yield* Ai.McpServer("filesystem-claude", {
    tool: "claude",
    name: "filesystem",
    transport: {
      _tag: "Stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/code"],
    },
  });

  // A remote MCP server. Stdio and Remote are separate variants, so a server
  // with both a command and a url — or with neither — cannot be written at
  // all, rather than being ruled out by a comment.
  yield* Ai.McpServer("linear-claude", {
    tool: "claude",
    name: "linear",
    transport: { _tag: "Remote", url: "https://mcp.linear.app/sse" },
  });

  // The same server registered for a second tool, since each keeps its own
  // config file and neither reads the other's.
  yield* Ai.McpServer("filesystem-codex", {
    tool: "codex",
    name: "filesystem",
    transport: {
      _tag: "Stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/code"],
    },
  });

  // These derive their own resource ids from `tool`, so one call per tool is
  // the whole API surface.
  yield* Ai.aiSkill({ home, vaultDir, tool: "claude" });
  yield* Ai.aiConfig({ home, vaultDir, tool: "claude" });
  yield* Ai.aiSkill({ home, vaultDir, tool: "cursor" });
});
