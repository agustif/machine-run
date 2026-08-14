import { expect, it } from "@effect/vitest";
import { renderGhAccountSwitchCommand } from "../src/Identity.ts";

it("renders a plain gh account without quoting", () => {
  expect(renderGhAccountSwitchCommand("agustif")).toBe(
    "gh auth switch --user agustif >/dev/null 2>&1",
  );
});

it("quotes shell metacharacters in a gh account", () => {
  expect(renderGhAccountSwitchCommand("victim; touch pwned")).toBe(
    "gh auth switch --user 'victim; touch pwned' >/dev/null 2>&1",
  );
});
