import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Sh from "../Sh.ts";
import { fromPosixMode, toIcaclsArgv, toWindowsAclPlan, type PermissionsTarget } from "./FilePermissions.ts";
import { matchesMode } from "./Icacls.ts";

/**
 * The two halves a resource needs to keep a POSIX `mode` meaningful on Windows,
 * where there is nothing to observe: Node reports `0o666` for every file and
 * `chmod` only toggles the read-only bit, so both reading and writing a mode have
 * to go through the ACL instead.
 *
 * Both take an `exec` rather than being methods on a service, because the only
 * thing they need is the ability to run one command, and every reconciler already
 * has that from its own context.
 */

/** How the caller runs a command — structurally `Reconciler`'s `Exec`, without
 * `core` depending on `engine` to say so. */
type RunCommand = (props: {
  readonly command: Sh.ShellCommand;
  readonly shell: boolean;
}) => Effect.Effect<{ readonly stdout: string }, unknown>;

/**
 * `icacls <path>`'s raw listing, for a resource to carry in its own state so a
 * synchronous `matches` can consult it later.
 *
 * `Option.none()` when the listing could not be read, which callers must treat as
 * "cannot confirm" — converging by re-applying — rather than as satisfied.
 */
export const readAcl = (
  exec: RunCommand,
  path: string,
): Effect.Effect<Option.Option<string>, never> =>
  exec({ command: Sh.pwsh("icacls", path), shell: true }).pipe(
    Effect.map((result) => Option.some(result.stdout)),
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.catchCause(() => Effect.succeed(Option.none<string>())),
  );

/**
 * Whether a live listing grants no more than `mode` intends.
 *
 * An unreadable or unparseable listing is `false`, never `true`: a mode that
 * cannot be confirmed has to be re-applied, and defaulting the other way would
 * report a permission state nobody checked.
 */
export const aclSatisfiesMode = (
  acl: Option.Option<string>,
  path: string,
  mode: number,
  target: PermissionsTarget,
): boolean =>
  Option.match(acl, {
    onNone: () => false,
    onSome: (listing) => Result.getOrElse(matchesMode(listing, path, mode, target), () => false),
  });

/** Applies `mode` as an ACL — the Windows counterpart to `chmod`. */
export const applyMode = (
  exec: RunCommand,
  path: string,
  mode: number,
  target: PermissionsTarget,
): Effect.Effect<void, unknown> =>
  exec({
    command: Sh.pwsh(...toIcaclsArgv(path, toWindowsAclPlan(fromPosixMode(mode, target)))),
    shell: true,
  }).pipe(Effect.asVoid);
