import * as Layer from "effect/Layer";
import { FileProvider } from "./File.ts";
import { ManagedBlockProvider } from "./ManagedBlock.ts";
import { SymlinkProvider } from "./Symlink.ts";

export const providers = () =>
  Layer.mergeAll(FileProvider(), ManagedBlockProvider(), SymlinkProvider());
