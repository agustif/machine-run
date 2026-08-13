import * as Layer from "effect/Layer";
import { ConfigProvider } from "./Config.ts";
import { RepoProvider } from "./Repo.ts";

/**
 * The two `Reconciler`-backed resources this package defines. Every other
 * export (`gitIgnore`, `gitAttributes`, `gitAlias`, `gitSigning`,
 * `gitCredentialHelper`, `gitHooksPath`, `gitIdentity`) is a composition over
 * {@link Config} and/or `@machine-run/dotfiles`' own resources, so it needs
 * no provider of its own — a recipe using any of them still needs
 * `@machine-run/dotfiles`'s `providers()` alongside this one.
 *
 * Like `dotfiles`' own `Providers.ts`, this does not include
 * `@machine-run/core`'s `services()` — that is provided once, beneath every
 * package's providers, by whoever assembles the stack.
 */
export const providers = () => Layer.mergeAll(ConfigProvider(), RepoProvider());
