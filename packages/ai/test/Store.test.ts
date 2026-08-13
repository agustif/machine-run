import { AiMcpToolId } from "@machine-run/ai";
import { aiToolBackend, aiToolBackends } from "@machine-run/ai";
import { expect, it } from "vitest";

it("every backend's own id matches the key it is registered under", () => {
  for (const [id, backend] of Object.entries(aiToolBackends)) {
    expect(backend.id).toBe(id);
  }
});

it("aiToolBackend dispatches by id to the same object the registry holds", () => {
  expect(aiToolBackend("claude")).toBe(aiToolBackends.claude);
  expect(aiToolBackend("codex")).toBe(aiToolBackends.codex);
});

it("every tool AiMcpToolId names actually has a populated `mcp` backend", () => {
  for (const tool of AiMcpToolId.literals) {
    expect(aiToolBackend(tool).mcp).toBeDefined();
  }
});

it("no tool outside AiMcpToolId claims MCP support it was never verified to have", () => {
  const mcpToolIds = new Set<string>(AiMcpToolId.literals);
  for (const [id, backend] of Object.entries(aiToolBackends)) {
    if (!mcpToolIds.has(id)) expect(backend.mcp).toBeUndefined();
  }
});
