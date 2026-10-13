/**
 * The read edition this release is built on — `@dexe-network/dexe-mcp`, pinned
 * EXACTLY (its code runs on the signing path: approval review, decoding, the env
 * loader). Every place that tells a user how to start the read server next to
 * this one names this exact version, so the read server they install is the
 * one this release was tested with.
 *
 * tests/release/read-package-pin.test.ts holds this constant to package.json's
 * dependency (while that is the vendored `file:` tarball, to the tarball's
 * version) and every shipped snippet to this constant. Bump it together with the
 * dependency.
 */
export const READ_PACKAGE = "@dexe-network/dexe-mcp";
export const READ_PACKAGE_VERSION = "1.0.0-rc.1";

/** The one-line command that starts the pinned read server over stdio. */
export const READ_SERVER_NPX = `npx -y -p ${READ_PACKAGE}@${READ_PACKAGE_VERSION} dexe-mcp-read`;
