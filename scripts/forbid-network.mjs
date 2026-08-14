import net from "node:net";
import dns from "node:dns";
import tls from "node:tls";

const blocked = () => {
  // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- a blocked socket must fail synchronously before any test can observe network access.
  throw new Error("network access is disabled in the hermetic test tier");
};

// This is deliberately a test-process guard, not production code. It catches
// the failure mode that motivated the split: a default test silently growing a
// loopback server or a real network client. Live tests run without this preload.
net.Server.prototype.listen = blocked;
net.Socket.prototype.connect = blocked;
net.createConnection = blocked;
net.connect = blocked;
dns.lookup = blocked;
dns.promises.lookup = blocked;
tls.connect = blocked;
// oxlint-disable-next-line effect/noAsyncFunction -- fetch's contract is a rejected Promise, which this preload must preserve.
globalThis.fetch = async () => blocked();
