import { expect, it } from "@effect/vitest";
import { parseFingerprint, parsePublicKey } from "../src/Key.ts";

it("parsePublicKey reads type and comment from a captured OpenSSH public key line", () => {
  const line =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMBPRMl3j36RIng7sMf+ciTKq/tHYZczpAuCtgyOoq5j test-comment\n";
  expect(parsePublicKey(line)).toEqual({ keyType: "ssh-ed25519", comment: "test-comment" });
});

it("parsePublicKey keeps a multi-word comment intact", () => {
  expect(parsePublicKey("ssh-ed25519 AAAAsomekeymaterial work laptop")).toEqual({
    keyType: "ssh-ed25519",
    comment: "work laptop",
  });
});

it("parsePublicKey reports an empty comment when none was given", () => {
  const line =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIZG0KpN23EMluPT5TxShl42ZjJhVAsXw/Nk65xesWPe \n";
  expect(parsePublicKey(line)).toEqual({ keyType: "ssh-ed25519", comment: "" });
});

it("parsePublicKey rejects a line with no key material", () => {
  expect(parsePublicKey("ssh-ed25519")).toBeUndefined();
  expect(parsePublicKey("")).toBeUndefined();
});

it("parseFingerprint reads the SHA256 field from captured ssh-keygen output", () => {
  const output = "256 SHA256:pxiH72Fxf2aHIOr/FB5eC/dwbavL1FeTz2RQq67k8sI test-comment (ED25519)\n";
  expect(parseFingerprint(output)).toBe("SHA256:pxiH72Fxf2aHIOr/FB5eC/dwbavL1FeTz2RQq67k8sI");
});

it("parseFingerprint ignores SHA256 text in a later comment field", () => {
  expect(parseFingerprint("256 SHA256:realhash my SHA256: fake comment (ED25519)")).toBe(
    "SHA256:realhash",
  );
});

it("parseFingerprint reports undefined when the expected field is absent", () => {
  expect(parseFingerprint("not a real ssh-keygen line")).toBeUndefined();
  expect(parseFingerprint("")).toBeUndefined();
});
