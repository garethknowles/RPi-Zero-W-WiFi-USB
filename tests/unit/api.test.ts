import { afterEach, describe, expect, test } from "bun:test";
import { basicAuth, startServer, type TestServer } from "../helpers/server";

let server: TestServer | null = null;

afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

describe("GET /", () => {
  test("returns the inline HTML page", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("AnkerMake File Manager");
    expect(html).toContain("/api/list");
  });
});

describe("GET /api/list", () => {
  test("returns an empty list for a fresh root", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/list");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ items: [] });
  });

  test("sorts folders before files, alphabetically", async () => {
    server = await startServer();
    await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "zfolder" }));
    await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "afolder" }));
    await uploadFile(server.url, "", "z.gcode", "x");
    await uploadFile(server.url, "", "a.gcode", "x");
    const list = (await (await fetch(server.url + "/api/list")).json()) as { items: { name: string; dir: boolean }[] };
    expect(list.items.map((i) => i.name)).toEqual(["afolder", "zfolder", "a.gcode", "z.gcode"]);
  });

  test("rejects path traversal with 400", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/list?path=" + encodeURIComponent("../../etc"));
    expect(r.status).toBe(400);
  });

  test("returns 404 for a missing directory", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/list?path=nope");
    expect(r.status).toBe(404);
  });
});

describe("POST /api/mkdir", () => {
  test("creates a folder and lists it", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "models" }));
    expect(r.status).toBe(200);
    const list = (await (await fetch(server.url + "/api/list")).json()) as { items: { name: string; dir: boolean }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ name: "models", dir: true });
  });

  test("rejects empty / invalid names", async () => {
    server = await startServer();
    expect((await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "" }))).status).toBe(400);
    expect((await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "." }))).status).toBe(400);
    expect((await fetch(server.url + "/api/mkdir", postJson({ path: "", name: ".." }))).status).toBe(400);
  });

  test("conflicts with 409 when the folder exists", async () => {
    server = await startServer();
    await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "models" }));
    const r = await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "models" }));
    expect(r.status).toBe(409);
  });
});

describe("POST /api/upload", () => {
  test("saves a file and reads it back via /api/download", async () => {
    server = await startServer();
    const r = await uploadFile(server.url, "", "cube.gcode", "G1 X0\n");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ saved: ["cube.gcode"] });

    const dl = await fetch(server.url + "/api/download?path=cube.gcode");
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("G1 X0\n");
  });

  test("saves multiple files in one request", async () => {
    server = await startServer();
    const form = new FormData();
    form.append("files", new Blob(["a"]), "a.gcode");
    form.append("files", new Blob(["bb"]), "b.gcode");
    const r = await fetch(server.url + "/api/upload", { method: "POST", body: form });
    expect(((await r.json()) as { saved: string[] }).saved).toEqual(["a.gcode", "b.gcode"]);
  });

  test("strips path components from the uploaded filename", async () => {
    server = await startServer();
    const r = await uploadFile(server.url, "", "../../evil.gcode", "x");
    expect(((await r.json()) as { saved: string[] }).saved).toEqual(["evil.gcode"]);
    const list = (await (await fetch(server.url + "/api/list")).json()) as { items: { name: string }[] };
    expect(list.items.map((i) => i.name)).toEqual(["evil.gcode"]);
  });

  test("sanitises FAT32-illegal characters in filenames", async () => {
    server = await startServer();
    const r = await uploadFile(server.url, "", 'bad:name*?.gcode', "x");
    expect(((await r.json()) as { saved: string[] }).saved).toEqual(["bad_name__.gcode"]);
  });

  test("rejects upload into a non-existent folder", async () => {
    server = await startServer();
    const r = await uploadFile(server.url, "missing", "x.gcode", "x");
    expect(r.status).toBe(404);
  });

  test("rejects upload with no file part", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/upload", { method: "POST", body: new FormData() });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/delete", () => {
  test("deletes a file", async () => {
    server = await startServer();
    await uploadFile(server.url, "", "x.gcode", "x");
    const r = await fetch(server.url + "/api/delete", postJson({ path: "x.gcode" }));
    expect(r.status).toBe(200);
    const list = (await (await fetch(server.url + "/api/list")).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  test("recursively deletes a folder with contents", async () => {
    server = await startServer();
    await fetch(server.url + "/api/mkdir", postJson({ path: "", name: "stuff" }));
    await uploadFile(server.url, "stuff", "a.gcode", "x");
    await uploadFile(server.url, "stuff", "b.gcode", "y");
    const r = await fetch(server.url + "/api/delete", postJson({ path: "stuff" }));
    expect(r.status).toBe(200);
    const list = (await (await fetch(server.url + "/api/list")).json()) as { items: unknown[] };
    expect(list.items).toEqual([]);
  });

  test("refuses to delete the root", async () => {
    server = await startServer();
    const r = await fetch(server.url + "/api/delete", postJson({ path: "" }));
    expect(r.status).toBe(400);
  });
});

describe("GET /api/status", () => {
  test("reports the file count, free/total bytes and driver", async () => {
    server = await startServer({ driver: "g_multi" });
    await uploadFile(server.url, "", "a.gcode", "abc");
    await uploadFile(server.url, "", "b.gcode", "defgh");
    const s = (await (await fetch(server.url + "/api/status")).json()) as {
      files: number;
      free: number;
      total: number;
      driver: string;
    };
    expect(s.files).toBe(2);
    expect(s.driver).toBe("g_multi");
    expect(s.total).toBeGreaterThan(0);
    expect(s.free).toBeGreaterThanOrEqual(0);
  });
});

describe("authentication", () => {
  test("requires Basic Auth when FM_USER is set", async () => {
    server = await startServer({ user: "anker", pass: "hunter2" });
    expect((await fetch(server.url + "/api/status")).status).toBe(401);
    expect(
      (await fetch(server.url + "/api/status", { headers: { authorization: basicAuth("anker", "wrong") } })).status,
    ).toBe(401);
    expect(
      (await fetch(server.url + "/api/status", { headers: { authorization: basicAuth("anker", "hunter2") } })).status,
    ).toBe(200);
  });

  test("returns a WWW-Authenticate challenge on 401", async () => {
    server = await startServer({ user: "anker", pass: "x" });
    const r = await fetch(server.url + "/api/status");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Basic");
  });

  test("rejects a malformed Authorization header", async () => {
    server = await startServer({ user: "anker", pass: "x" });
    const r = await fetch(server.url + "/api/status", { headers: { authorization: "Bearer xyz" } });
    expect(r.status).toBe(401);
  });

  test("is disabled when FM_USER is empty", async () => {
    server = await startServer();
    expect((await fetch(server.url + "/api/status")).status).toBe(200);
  });
});

describe("USB gadget replug (mocked)", () => {
  test("calls modprobe -r then load on startup with FM_USB_IMAGE and FM_DRIVER", async () => {
    server = await startServer({ driver: "g_mass_storage", usbImage: "/tmp/fake-piusb.bin" });
    await server.awaitModprobeCall(2000);
    // Let both the unload and load land.
    await new Promise((r) => setTimeout(r, 200));
    const calls = await server.readModprobeCalls();
    expect(calls).toContain("-r g_mass_storage");
    const load = calls.find((l) => l.startsWith("g_mass_storage "));
    expect(load).toBeDefined();
    expect(load).toContain("file=/tmp/fake-piusb.bin");
    expect(load).toContain("stall=0");
    expect(load).toContain("removable=1");
  });

  test("replugs when a file is uploaded", async () => {
    server = await startServer({ debounceMs: 50 });
    await server.awaitModprobeCall(2000); // drain the startup replug
    await new Promise((r) => setTimeout(r, 200));
    await server.clearModprobeCalls();

    await uploadFile(server.url, "", "trigger.gcode", "x");
    await server.awaitModprobeCall(2000);
    await new Promise((r) => setTimeout(r, 200)); // let the load line land too
    const calls = await server.readModprobeCalls();
    expect(calls.some((l) => l.startsWith("g_mass_storage "))).toBe(true);
  });

  test("replugs after delete", async () => {
    server = await startServer({ debounceMs: 50 });
    await uploadFile(server.url, "", "x.gcode", "x");
    await server.awaitModprobeCall(2000);
    await new Promise((r) => setTimeout(r, 200));
    await server.clearModprobeCalls();

    await fetch(server.url + "/api/delete", postJson({ path: "x.gcode" }));
    await server.awaitModprobeCall(2000);
    await new Promise((r) => setTimeout(r, 200));
    const calls = await server.readModprobeCalls();
    expect(calls.some((l) => l.startsWith("g_mass_storage "))).toBe(true);
  });

  test("uses the configured driver name (g_multi)", async () => {
    server = await startServer({ driver: "g_multi" });
    await server.awaitModprobeCall(2000);
    await new Promise((r) => setTimeout(r, 200));
    const calls = await server.readModprobeCalls();
    expect(calls.some((l) => l.startsWith("g_multi") || l === "-r g_multi")).toBe(true);
    expect(calls.every((l) => !l.includes("g_mass_storage"))).toBe(true);
  });

  test("never calls modprobe when FM_DRIVER is empty (dev mode)", async () => {
    server = await startServer({ driver: "" });
    await new Promise((r) => setTimeout(r, 400));
    await uploadFile(server.url, "", "x.gcode", "x");
    await new Promise((r) => setTimeout(r, 400));
    expect(await server.readModprobeCalls()).toEqual([]);
  });

  test("coalesces a burst of uploads into a single replug cycle", async () => {
    server = await startServer({ debounceMs: 200 });
    await server.awaitModprobeCall(2000); // drain startup
    await new Promise((r) => setTimeout(r, 400));
    await server.clearModprobeCalls();

    // Fire several uploads inside the debounce window.
    await Promise.all([
      uploadFile(server.url, "", "a.gcode", "1"),
      uploadFile(server.url, "", "b.gcode", "2"),
      uploadFile(server.url, "", "c.gcode", "3"),
    ]);

    await server.awaitModprobeCall(2000);
    await new Promise((r) => setTimeout(r, 400)); // let any further cycles land
    const calls = await server.readModprobeCalls();
    // One unload + one load = 2 lines per cycle. Coalesced = exactly 2.
    expect(calls.length).toBe(2);
    expect(calls.filter((l) => l.startsWith("-r ")).length).toBe(1);
    expect(calls.filter((l) => l.startsWith("g_mass_storage ")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// small fetch helpers
// ---------------------------------------------------------------------------
function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function uploadFile(base: string, path: string, name: string, content: string): Promise<Response> {
  const form = new FormData();
  form.append("files", new Blob([content]), name);
  return fetch(base + "/api/upload?path=" + encodeURIComponent(path), {
    method: "POST",
    body: form,
  });
}
