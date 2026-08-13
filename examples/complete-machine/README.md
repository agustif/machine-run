# complete-machine

Every resource kind this repo defines, exercised once, as compiled code.

**This is a reference, not a machine.** Do not deploy it as written. It names
secret references that do not exist, a placeholder download checksum, a `chsh`
call, and both macOS _and_ Linux desktop settings — which cannot both apply on
one host. Copy the recipes you want into your own stack.

For a recipe meant to actually run, see
[`examples/example-machine`](../example-machine).

## Why it exists

`examples/example-machine` used to carry four of these domains as commented-out
prose. Commented-out code is never type-checked, so it kept referencing
`@machine-run/ai-tools` for as long as that package had been deleted, and
nothing went red. A resource with no example is a resource whose props nobody
has ever had to spell correctly.

So everything here is real code:

- `tsc -b` catches a prop rename the moment it happens.
- [`packages/machine/test/ExampleCoverage.test.ts`](../../packages/machine/test/ExampleCoverage.test.ts)
  fails, naming the resource, if a new kind lands without a call here.

That test resolves import aliases rather than grepping identifiers, because
`Repo` is exported by both `@machine-run/git` and `@machine-run/system-packages`
and an unqualified match would let either satisfy both.

## Layout

One module per domain, so adding a resource means editing the module that owns
its domain.

| Recipe                | Resources                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `recipes/packages.ts` | `System.Repo`, `System.Package`                                                             |
| `recipes/dotfiles.ts` | `Machine.File`, `.Directory`, `.Symlink`, `.ManagedBlock`, `.Download`, `.Exec`             |
| `recipes/shell.ts`    | `Shell.Login`, plus the rc-file compositions                                                |
| `recipes/git.ts`      | `Git.Config`, `Git.Repo`, plus personas/ignore/attributes/aliases/credentials/signing/hooks |
| `recipes/runtimes.ts` | `Runtime.Tool` across mise, asdf, rustup                                                    |
| `recipes/secrets.ts`  | `Machine.SecretFile` across all five backends                                               |
| `recipes/ai.ts`       | `Ai.McpServer`, skill and config symlinks                                                   |
| `recipes/macos.ts`    | `MacOS.Default`, including array and dictionary values                                      |
| `recipes/linux.ts`    | `System.Setting` over gsettings and dconf                                                   |
| `recipes/network.ts`  | `Tailscale.Connection`, `sshHost`                                                           |

## Adding a resource kind

1. Add the call to the recipe that owns its domain, with real props.
2. Add its package to `package.json` and to `tsconfig.json`'s `references` if
   it is not already there.
3. `npm run build && npm test`.

Step 3 is where you find out whether the props you wrote exist.
