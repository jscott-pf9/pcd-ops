import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADERS, apiFetch, errorDetail, redirectForAuth, safeNext } from "./client";

function stubLocation(pathname: string, search = "") {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { pathname, search, assign } });
  return assign;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/snapshots?x=1")).toBe("/snapshots?x=1");
  });
  it("refuses other sites, protocol-relative URLs and the login page", () => {
    for (const bad of [null, "", "https://evil.example/", "//evil.example/", "/\\evil.example", "/login"]) {
      expect(safeNext(bad)).toBe("/");
    }
  });
});

describe("redirectForAuth", () => {
  it("sends a 401 to /login with the current page as next", () => {
    const assign = stubLocation("/snapshots", "?t=1");
    expect(redirectForAuth(401, "")).toBe(true);
    expect(assign).toHaveBeenCalledWith("/login?next=%2Fsnapshots%3Ft%3D1");
  });
  it("sends a setup_required 409 to /setup", () => {
    const assign = stubLocation("/");
    expect(redirectForAuth(409, '{"setup_required":true}')).toBe(true);
    expect(assign).toHaveBeenCalledWith("/setup");
  });
  it("leaves other errors, and the login page itself, alone", () => {
    const assign = stubLocation("/login");
    expect(redirectForAuth(401, "")).toBe(false);
    expect(redirectForAuth(409, '{"detail":"already running"}')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("apiFetch", () => {
  it("sends the CSRF header and same-origin cookies", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiFetch("/jobs/1/run", { method: "POST" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/jobs/1/run");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toMatchObject(CSRF_HEADERS);
  });
});

describe("errorDetail", () => {
  it("extracts FastAPI's detail message", () => {
    const err = new Error('401 Unauthorized: {"detail":"Your PCD account needs the admin role in project service."}');
    expect(errorDetail(err)).toBe("Your PCD account needs the admin role in project service.");
  });
  it("falls back to the raw message", () => {
    expect(errorDetail(new Error("network down"))).toBe("network down");
  });
});
