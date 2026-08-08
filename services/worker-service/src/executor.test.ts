import { describe, expect, it, vi } from "vitest";
import {
  BuildExecutorError,
  dockerBuildExecutor,
  stubBuildExecutor,
  type DockerBuildExecutorConfig,
} from "./executor";
import { RepoUrlError } from "./repo-url-guard";

const repoInput = {
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.94.0",
  buildFlags: ["--release"],
};

// Pass-through SSRF guard for tests that aren't exercising the guard itself, so
// they don't hit real DNS (the guard has its own dedicated tests).
const passRepoUrl = async () => {};

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

  it("passes https protocol pins + `--` separator to git clone", async () => {
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, assertRepoUrl: passRepoUrl });
    await ex.build(repoInput).catch(() => {}); // reaches artifact read + throws; we only inspect args
    const cloneCall = calls.find(
      (c) => c.cmd === "git" && c.args[c.args.indexOf("clone") ?? -1] === "clone",
    );
    expect(cloneCall?.args).toContain("protocol.allow=never");
    expect(cloneCall?.args).toContain("--");
    // repoUrl comes AFTER the -- so a "-"-prefixed value can't be an option.
    const sep = cloneCall!.args.indexOf("--");
    expect(cloneCall!.args.indexOf(repoInput.repoUrl)).toBeGreaterThan(sep);
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
