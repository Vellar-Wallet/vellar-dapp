import { describe, expect, it, vi } from "vitest";
import {
  BuildExecutorError,
  dockerBuildExecutor,
  stubBuildExecutor,
  type DockerBuildExecutorConfig,
} from "./executor";
import { assertPublicHttpsRepoUrl, RepoUrlError } from "./repo-url-guard";

const repoInput = {
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.94.0",
  buildFlags: ["--release"],
};

// Pass-through SSRF guard for tests that aren't exercising the guard itself, so
// they don't hit real DNS (the guard has its own dedicated tests). Returns a
// fixed public pin, as the real guard would.
const passRepoUrl = async () => ({ host: "github.com", port: 443, ip: "140.82.112.3" });

// A fake `run` seam that scripts responses per command and records the docker
// args, so we can assert isolation flags + timeout wiring without real Docker.
function fakeRun(opts: {
  cloneCode?: number;
  checkoutCode?: number;
  buildCode?: number;
  buildTimedOut?: boolean;
  wasmList?: string;
}) {
  const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
  const run: NonNullable<DockerBuildExecutorConfig["run"]> = async (cmd, args, _cwd, timeoutMs) => {
    calls.push({ cmd, args, timeoutMs });
    // clone args now carry `-c protocol...` flags before the subcommand, so
    // match by presence, not position.
    if (cmd === "git" && args.includes("clone"))
      return { code: opts.cloneCode ?? 0, out: "cloned" };
    if (cmd === "git" && args.includes("checkout"))
      return { code: opts.checkoutCode ?? 0, out: "checked out" };
    if (cmd === "docker")
      return { code: opts.buildCode ?? 0, out: "built", timedOut: opts.buildTimedOut };
    if (cmd === "sh") return { code: 0, out: opts.wasmList ?? "" };
    return { code: 0, out: "" };
  };
  return { run, calls };
}

describe("dockerBuildExecutor isolation", () => {
  it("runs the build with strict container isolation flags", async () => {
    const { run, calls } = fakeRun({
      wasmList: "target/wasm32v1-none/release/x.wasm",
    });
    // readFile will fail (no real file) — we only care about the docker args,
    // so let the build reach artifact reading and throw artifact_missing.
    const ex = dockerBuildExecutor({ image: "vela-verify:test", run, assertRepoUrl: passRepoUrl });
    await expect(ex.build(repoInput)).rejects.toBeInstanceOf(BuildExecutorError);

    const dockerCall = calls.find((c) => c.cmd === "docker");
    expect(dockerCall).toBeDefined();
    const a = dockerCall!.args.join(" ");
    expect(a).toContain("--network=none");
    expect(a).toContain("--memory 2g");
    expect(a).toContain("--memory-swap 2g");
    expect(a).toContain("--cpus 2");
    expect(a).toContain("--pids-limit 512");
    expect(a).toContain("--read-only");
    expect(a).toContain("--tmpfs /tmp:exec");
    expect(a).toContain("--cap-drop=ALL");
    expect(a).toContain("no-new-privileges");
    expect(a).toContain("--user 1000:1000");
  });

  it("passes the configured timeout (ms) to the build run", async () => {
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({
      image: "img",
      run,
      timeoutSeconds: 42,
      assertRepoUrl: passRepoUrl,
    });
    await expect(ex.build(repoInput)).rejects.toBeInstanceOf(BuildExecutorError);
    const dockerCall = calls.find((c) => c.cmd === "docker");
    expect(dockerCall!.timeoutMs).toBe(42_000);
  });

  it("honors custom resource caps", async () => {
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({
      image: "img",
      run,
      memory: "4g",
      cpus: "1",
      pidsLimit: 128,
      assertRepoUrl: passRepoUrl,
    });
    await expect(ex.build(repoInput)).rejects.toBeInstanceOf(BuildExecutorError);
    const a = calls.find((c) => c.cmd === "docker")!.args.join(" ");
    expect(a).toContain("--memory 4g");
    expect(a).toContain("--cpus 1");
    expect(a).toContain("--pids-limit 128");
  });

  it("fails with build_failed when the build times out", async () => {
    const { run } = fakeRun({ buildTimedOut: true, buildCode: 124 });
    const ex = dockerBuildExecutor({
      image: "img",
      run,
      timeoutSeconds: 1,
      assertRepoUrl: passRepoUrl,
    });
    await expect(ex.build(repoInput)).rejects.toMatchObject({
      name: "BuildExecutorError",
      code: "build_failed",
    });
    await expect(ex.build(repoInput)).rejects.toThrow(/timeout/i);
  });

  it("fails with clone_failed when git clone fails", async () => {
    const { run } = fakeRun({ cloneCode: 1 });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: passRepoUrl });
    await expect(ex.build(repoInput)).rejects.toMatchObject({ code: "clone_failed" });
  });

  it("rejects a repoUrl the SSRF guard blocks BEFORE cloning (FIX 6)", async () => {
    const { run, calls } = fakeRun({});
    const ex = dockerBuildExecutor({
      image: "img",
      run,
      assertRepoUrl: async () => {
        throw new RepoUrlError("blocked");
      },
    });
    await expect(ex.build(repoInput)).rejects.toMatchObject({ code: "repo_url_rejected" });
    // git clone must never run when the guard rejects.
    expect(calls.find((c) => c.cmd === "git")).toBeUndefined();
  });

  it("pins the connection to the guard IP, forbids redirects, and `--`-separates the url", async () => {
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: passRepoUrl });
    await ex.build(repoInput).catch(() => {}); // reaches artifact read + throws; we only inspect args
    const cloneCall = calls.find(
      (c) => c.cmd === "git" && c.args[c.args.indexOf("clone") ?? -1] === "clone",
    );
    expect(cloneCall?.args).toContain("protocol.allow=never");
    // Connection pinned to the guard-validated IP (no independent re-resolution).
    expect(cloneCall?.args).toContain("http.curloptResolve=github.com:443:140.82.112.3");
    // Redirects forbidden so a 30x can't send git to an unpinned host.
    expect(cloneCall?.args).toContain("http.followRedirects=false");
    expect(cloneCall?.args).toContain("--");
    // repoUrl comes AFTER the -- so a "-"-prefixed value can't be an option.
    const sep = cloneCall!.args.indexOf("--");
    expect(cloneCall!.args.indexOf(repoInput.repoUrl)).toBeGreaterThan(sep);
  });

  it("rebinding: DNS flipping public→private connects to the pinned public IP, never the private one", async () => {
    // The real guard resolves ONCE (public), returns that pin; the executor
    // pins git to it. Even if the next DNS lookup would return a private
    // address, git connects to the pinned public IP. Here the guard sees public
    // and we assert the pin carries the public IP into the clone command.
    let call = 0;
    const flippingResolve = async () => {
      call += 1;
      return call === 1 ? ["93.184.216.34"] : ["169.254.169.254"]; // public, then private
    };
    const guard = (repoUrl: string) =>
      assertPublicHttpsRepoUrl(repoUrl, { resolve: flippingResolve });
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: guard });
    await ex.build(repoInput).catch(() => {});
    const cloneCall = calls.find(
      (c) => c.cmd === "git" && c.args[c.args.indexOf("clone") ?? -1] === "clone",
    );
    // Pinned to the PUBLIC IP the guard validated; the later private answer is
    // never used (git does not re-resolve).
    expect(cloneCall?.args).toContain("http.curloptResolve=github.com:443:93.184.216.34");
    expect(cloneCall?.args.join(" ")).not.toContain("169.254.169.254");
  });

  it("pins the exact IP the guard RESOLVED (not a fixture) — plumbing guard", async () => {
    // The pinned IP must be whatever the resolver returned, threaded through the
    // real assertPublicHttpsRepoUrl into the executor. Assert against the value
    // the resolver actually produced (captured), so a refactor that breaks the
    // guard→executor plumbing — e.g. dropping the returned pin, or the executor
    // ignoring it — fails loudly instead of matching a hardcoded constant.
    const resolvedIp = "198.51.100.77"; // TEST-NET-2, public; known only to the resolver
    let handedToGuard: string | undefined;
    const capturingResolve = async () => {
      handedToGuard = resolvedIp;
      return [resolvedIp];
    };
    const guard = (repoUrl: string) =>
      assertPublicHttpsRepoUrl(repoUrl, { resolve: capturingResolve });
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: guard });
    await ex.build(repoInput).catch(() => {});

    const cloneCall = calls.find(
      (c) => c.cmd === "git" && c.args[c.args.indexOf("clone") ?? -1] === "clone",
    );
    // The resolver ran, and the clone pins EXACTLY what it returned.
    expect(handedToGuard).toBe(resolvedIp);
    expect(cloneCall?.args).toContain(`http.curloptResolve=github.com:443:${resolvedIp}`);
  });

  it("pins the URL's non-standard port, not a hardcoded 443", async () => {
    const guard = (repoUrl: string) =>
      assertPublicHttpsRepoUrl(repoUrl, { resolve: async () => ["203.0.113.9"] });
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: guard });
    await ex
      .build({ ...repoInput, repoUrl: "https://git.example.com:8443/repo.git" })
      .catch(() => {});
    const cloneCall = calls.find(
      (c) => c.cmd === "git" && c.args[c.args.indexOf("clone") ?? -1] === "clone",
    );
    expect(cloneCall?.args).toContain("http.curloptResolve=git.example.com:8443:203.0.113.9");
  });

  it("rebinding: a host that resolves private at guard time is rejected before any clone", async () => {
    const guard = (repoUrl: string) =>
      assertPublicHttpsRepoUrl(repoUrl, { resolve: async () => ["169.254.169.254"] });
    const { run, calls } = fakeRun({});
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: guard });
    await expect(ex.build(repoInput)).rejects.toMatchObject({ code: "repo_url_rejected" });
    expect(calls.find((c) => c.cmd === "git")).toBeUndefined();
  });

  it("rejects non-repo submissions (upload) with unsupported_source", async () => {
    const { run } = fakeRun({});
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: passRepoUrl });
    await expect(
      ex.build({ sourceType: "upload", sourceArchiveRef: "a", toolchainVersion: "1.94.0" }),
    ).rejects.toMatchObject({ code: "unsupported_source" });
  });
});

describe("build timeout kill (defaultRun path)", () => {
  it("stubBuildExecutor stays timeout-agnostic (no docker, always resolves)", async () => {
    // Sanity: the stub path doesn't shell out, so timeouts don't apply.
    const ex = stubBuildExecutor();
    const r = await ex.build(repoInput);
    expect(r.wasmHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
