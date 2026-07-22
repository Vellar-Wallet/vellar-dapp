import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import Verify from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/verify",
}));

// AppShell guards the session/redirects; stub it to a passthrough so the test
// focuses on the verification UI.
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { historyMock, submitMock } = vi.hoisted(() => ({
  historyMock: vi.fn(),
  submitMock: vi.fn(),
}));
vi.mock("@/lib/verification", async () => {
  const actual = await vi.importActual<typeof import("@/lib/verification")>("@/lib/verification");
  return {
    ...actual,
    getVerificationHistory: historyMock,
    submitVerification: submitMock,
  };
});

const C1 = "CAFK7NMQOT7G2SKMREDUII3EOK4APIY54WIK6CVGY72XWFE76YFRDF67";

beforeEach(() => {
  historyMock.mockReset();
  submitMock.mockReset();
});

describe("Verify page — explorer", () => {
  it("looks up a contract and shows the verified badge + record details", async () => {
    historyMock.mockResolvedValue([
      {
        id: "r1",
        contractId: C1,
        sourceType: "repo",
        repoUrl: "https://github.com/x/y",
        commitHash: "a1b2c3d",
        toolchainVersion: "1.81.0",
        outputHash: "hh".repeat(32),
        deployedHash: "hh".repeat(32),
        status: "verified",
        createdAt: "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ]);

    render(<Verify />);
    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: C1 } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() => expect(historyMock).toHaveBeenCalledWith(C1));
    // The trust badge renders "Verified source".
    expect((await screen.findAllByText("Verified source")).length).toBeGreaterThan(0);
    expect(screen.getByText("1.81.0")).toBeDefined();
  });

  it("shows 'unverified' + a hint when no records exist", async () => {
    historyMock.mockResolvedValue([]);
    render(<Verify />);
    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: C1 } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() => expect(historyMock).toHaveBeenCalled());
    expect(screen.getByText("Unverified")).toBeDefined();
    expect(screen.getByText(/No verification has been submitted/i)).toBeDefined();
  });

  it("rejects an invalid contract id before calling the API", async () => {
    render(<Verify />);
    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: "not-valid" } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText(/valid contract address/i)).toBeDefined();
    expect(historyMock).not.toHaveBeenCalled();
  });
});

describe("Verify page — submit", () => {
  it("submits a repo verification and confirms receipt", async () => {
    submitMock.mockResolvedValue({
      id: "r2",
      contractId: C1,
      sourceType: "repo",
      status: "submitted",
      toolchainVersion: "1.81.0",
      createdAt: "x",
      updatedAt: "x",
    });

    render(<Verify />);
    fireEvent.click(screen.getByRole("tab", { name: "Submit for verification" }));

    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: C1 } });
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/x/y" },
    });
    fireEvent.change(screen.getByLabelText("Commit hash"), { target: { value: "a1b2c3d" } });
    fireEvent.change(screen.getByLabelText("Toolchain version"), { target: { value: "1.81.0" } });
    fireEvent.change(screen.getByLabelText(/Build flags/i), { target: { value: "--release" } });

    fireEvent.click(screen.getByRole("button", { name: "Submit for verification" }));

    await waitFor(() => expect(submitMock).toHaveBeenCalled());
    expect(submitMock.mock.calls[0]![0]).toMatchObject({
      contractId: C1,
      sourceType: "repo",
      repoUrl: "https://github.com/x/y",
      commitHash: "a1b2c3d",
      toolchainVersion: "1.81.0",
      buildFlags: ["--release"],
    });
    expect(await screen.findByText("Submission received")).toBeDefined();
  });

  it("blocks submit with a missing toolchain", async () => {
    render(<Verify />);
    fireEvent.click(screen.getByRole("tab", { name: "Submit for verification" }));
    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: C1 } });
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/x/y" },
    });
    fireEvent.change(screen.getByLabelText("Commit hash"), { target: { value: "a1b2c3d" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for verification" }));
    expect(await screen.findByText(/Toolchain version is required/i)).toBeDefined();
    expect(submitMock).not.toHaveBeenCalled();
  });
});
