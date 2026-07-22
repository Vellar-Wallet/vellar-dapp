import { describe, expect, it, vi } from "vitest";
import {
  BuildExecutorError,
  dockerBuildExecutor,
  stubBuildExecutor,
  type DockerBuildExecutorConfig,
} from "./executor";

const repoInput = {
  sourceType: "repo" as const,
  repoUrl: "https://github.com/example/contract",
  commitHash: "a1b2c3d",
  toolchainVersion: "1.94.0",
  buildFlags: ["--release"],
};

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
    if (cmd === "git" && args[0] === "clone") return { code: opts.cloneCode ?? 0, out: "cloned" };
    if (cmd === "git" && args[0] === "checkout")
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
    const ex = dockerBuildExecutor({ image: "vela-verify:test", run });
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
    const ex = dockerBuildExecutor({ image: "img", run, timeoutSeconds: 42 });
    await expect(ex.build(repoInput)).rejects.toBeInstanceOf(BuildExecutorError);
    const dockerCall = calls.find((c) => c.cmd === "docker");
    expect(dockerCall!.timeoutMs).toBe(42_000);
  });

  it("honors custom resource caps", async () => {
    const { run, calls } = fakeRun({ wasmList: "target/wasm32v1-none/release/x.wasm" });
    const ex = dockerBuildExecutor({ image: "img", run, memory: "4g", cpus: "1", pidsLimit: 128 });
    await expect(ex.build(repoInput)).rejects.toBeInstanceOf(BuildExecutorError);
    const a = calls.find((c) => c.cmd === "docker")!.args.join(" ");
    expect(a).toContain("--memory 4g");
    expect(a).toContain("--cpus 1");
    expect(a).toContain("--pids-limit 128");
  });

  it("fails with build_failed when the build times out", async () => {
    const { run } = fakeRun({ buildTimedOut: true, buildCode: 124 });
    const ex = dockerBuildExecutor({ image: "img", run, timeoutSeconds: 1 });
    await expect(ex.build(repoInput)).rejects.toMatchObject({
      name: "BuildExecutorError",
      code: "build_failed",
    });
    await expect(ex.build(repoInput)).rejects.toThrow(/timeout/i);
  });

  it("fails with clone_failed when git clone fails", async () => {
    const { run } = fakeRun({ cloneCode: 1 });
    const ex = dockerBuildExecutor({ image: "img", run });
    await expect(ex.build(repoInput)).rejects.toMatchObject({ code: "clone_failed" });
  });

  it("rejects non-repo submissions (upload) with unsupported_source", async () => {
    const { run } = fakeRun({});
    const ex = dockerBuildExecutor({ image: "img", run });
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
