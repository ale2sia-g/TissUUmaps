// @vitest-environment jsdom
// jsdom runs no scripts in the sandbox, and has no WebAssembly for Pyodide:
// these tests check the parts around it. What the sandbox blocks is checked
// in a real browser, with a Python script that tries to get out.
import { afterEach, describe, expect, it, vi } from "vitest";

import { startPythonKernel } from "./python-sandbox";

const files = { get: vi.fn(() => Promise.resolve(new ArrayBuffer(0))) };

afterEach(() => {
  document.body.replaceChildren();
  files.get.mockClear();
});

describe("startPythonKernel", () => {
  it("starts Python in an iframe that may only run scripts, with no network and no eval", async () => {
    const controller = new AbortController();
    const starting = startPythonKernel(files, { signal: controller.signal });
    const iframe = document.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.srcdoc).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:">`,
    );
    // Pyodide is imported only with the import() written as text, which Vite
    // does not rewrite
    expect(iframe.srcdoc.split("import(")).toHaveLength(2);
    controller.abort(new Error("stopped"));
    await expect(starting).rejects.toThrow("stopped");
  });

  it("gives no files before its sandbox is ready, and listens only to its own iframe", async () => {
    const controller = new AbortController();
    const starting = startPythonKernel(files, { signal: controller.signal });
    window.postMessage({ type: "ready" }, "*");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(files.get).not.toHaveBeenCalled();
    controller.abort(new Error("stopped"));
    await expect(starting).rejects.toThrow("stopped");
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not start when it is stopped already", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      startPythonKernel(files, { signal: controller.signal }),
    ).rejects.toThrow("stopped");
    expect(document.querySelector("iframe")).toBeNull();
  });
});
