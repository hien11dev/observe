import { loadOptionalPeer } from "./optional-peer.util.js";

describe("loadOptionalPeer", () => {
  it("reports a package that is not installed", () => {
    const result = loadOptionalPeer("@nestjs/definitely-not-a-real-package");

    expect(result).toEqual({ installed: false });
  });

  it("loads an installed package", () => {
    const result = loadOptionalPeer<typeof import("rxjs")>("rxjs");

    expect(result.installed).toBe(true);
    expect(result.installed && result.module?.Subscription).toEqual(
      expect.any(Function),
    );
  });

  it("keeps 'installed but unloadable' apart from 'not installed'", () => {
    const result = loadOptionalPeer(
      "rxjs",
      "rxjs/dist/no-such-file-anywhere.js",
    );

    expect(result.installed).toBe(true);
    expect(result.installed && result.module).toBeUndefined();
    expect(result.installed && result.error).toBeDefined();
  });
});
