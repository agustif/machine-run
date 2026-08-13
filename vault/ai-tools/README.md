## AI tool vault

Source-of-truth content for `@machine-run/ai-tools`'s `Dotfiles.Symlink` resources.

Nothing is auto-populated here — `Symlink` refuses to run if its `source`
doesn't exist, on purpose. To bring a tool's config under management:

1. Open the real file/directory (e.g. `~/.claude/settings.json` or
   `~/.claude/skills`) and confirm it contains no credentials, tokens,
   session state, or anything else you wouldn't want in git history.
2. Copy the reviewed content to the matching path here:
   - Skills: `vault/ai-tools/skills/<tool-id>/`
   - Config files: `vault/ai-tools/config/<tool-id>`
     (see `AI_TOOL_SKILLS_DIRS` / `AI_TOOL_CONFIG_FILES` in
     `packages/ai-tools/src/Vault.ts` for the exact `<tool-id>` values and
     which real paths they map to)
3. Run `alchemy plan` from the machine's app directory to confirm only that
   symlink shows up as a change, then `alchemy deploy`.

Never add: `auth.json`, anything named `*session*`/`*token*`/`*credential*`,
`*.db`/`*.sqlite*`, `logs/`, `cache/`, `*.lock`, or `history.jsonl`.
