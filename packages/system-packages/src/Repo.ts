import { CommandExecutor } from "alchemy/Command";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { makeAptBackend } from "./backends/Apt.ts";
import { makeBrewBackend } from "./backends/Brew.ts";
import type { PackageManagerBackend } from "./Backend.ts";

/** Only managers with a real, common "extra repo" concept (brew tap, apt PPA). dnf/pacman are out of scope for now — see README. */
export type RepoManagerId = "brew" | "apt";

export interface RepoProps {
  manager: RepoManagerId;
  /** e.g. "can1357/tap" (brew) or "ppa:some/ppa" (apt). */
  repo: string;
}

/**
 * One extra package repository (a Homebrew tap, an apt PPA) — atomic and
 * separate from {@link Package}, sequenced by ordinary `Effect.gen`
 * ordering (yield the Repo before the Packages that need it) rather than a
 * `dependsOn` field.
 */
export interface Repo extends Resource<"System.Repo", RepoProps, { manager: string; repo: string }> {}

export const Repo = Resource<Repo>("System.Repo");

export const RepoProvider = () =>
  Provider.effect(
    Repo,
    Effect.gen(function* () {
      const executor = yield* CommandExecutor;
      const backends: Record<RepoManagerId, PackageManagerBackend> = {
        brew: makeBrewBackend(executor),
        apt: makeAptBackend(executor),
      };

      return Repo.Provider.of({
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output || output.manager !== news.manager || output.repo !== news.repo) {
            return { action: "update" as const };
          }
        }),
        reconcile: Effect.fn(function* ({ news, session }) {
          const backend = backends[news.manager];
          const { listRepos, addRepo } = backend;
          if (listRepos && addRepo) {
            const existing = yield* listRepos(session);
            if (!existing.includes(news.repo)) {
              yield* addRepo(news.repo, session);
            }
          }
          return { manager: news.manager, repo: news.repo };
        }),
        delete: () => Effect.void,
      });
    }),
  );
