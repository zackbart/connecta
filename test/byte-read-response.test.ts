import { describe, expect, it, vi } from "vitest";
import { byteReadResponse } from "../src/byte-read-response.js";

const encoder = new TextEncoder();

describe("byte-reading responses", () => {
  it("INV-6: decodes UTF-8, strips BOMs, and replaces invalid sequences without native text readers", async () => {
    for (const [bytes, expected] of [
      [encoder.encode("Hello 世界 🌍"), "Hello 世界 🌍"],
      [new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), "a"],
      [new Uint8Array([0x61, 0xc3, 0x28, 0xff]), "a�(�"],
    ] as const) {
      const response = new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } });
      const nativeText = vi.spyOn(response, "text");
      const nativeJson = vi.spyOn(response, "json");
      expect(await byteReadResponse(response).text()).toBe(expected);
      expect(nativeText).not.toHaveBeenCalled();
      expect(nativeJson).not.toHaveBeenCalled();
    }
    const json = byteReadResponse(
      new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"value":"世界"}')])),
    );
    expect(await json.json()).toEqual({ value: "世界" });
  });

  it("INV-6: preserves response identity, metadata, bodyUsed, and independent wrapped clones", async () => {
    const original = new Response('{"value":1}', { status: 201, statusText: "Created", headers: { "X-Test": "kept" } });
    const body = original.body;
    const wrapped = byteReadResponse(original);
    expect(wrapped).toBe(original);
    expect(wrapped).toBeInstanceOf(Response);
    expect(wrapped.body).toBe(body);
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe("Created");
    expect(wrapped.headers.get("X-Test")).toBe("kept");
    expect(wrapped.url).toBe(original.url);
    expect(wrapped.redirected).toBe(original.redirected);
    const clone = wrapped.clone();
    expect(clone).toBeInstanceOf(Response);
    expect(Object.hasOwn(clone, "json")).toBe(true);
    expect(wrapped.bodyUsed).toBe(false);
    expect(await clone.json()).toEqual({ value: 1 });
    expect(clone.bodyUsed).toBe(true);
    expect(wrapped.bodyUsed).toBe(false);
    expect(await wrapped.text()).toBe('{"value":1}');
    expect(wrapped.bodyUsed).toBe(true);
    await expect(wrapped.json()).rejects.toBeInstanceOf(TypeError);
    expect(() => wrapped.clone()).toThrow(TypeError);
  });

  it("INV-6: leaves SSE streaming incremental through body", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const response = byteReadResponse(new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    expect(response.bodyUsed).toBe(false);
    const reader = response.body!.getReader();
    controller.enqueue(encoder.encode("data: first\n\n"));
    expect(await reader.read()).toEqual({ done: false, value: encoder.encode("data: first\n\n") });
    expect(response.bodyUsed).toBe(true);
    controller.enqueue(encoder.encode("data: second\n\n"));
    expect(await reader.read()).toEqual({ done: false, value: encoder.encode("data: second\n\n") });
    controller.close();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  it("INV-6: retains arrayBuffer and blob bytes and content type", async () => {
    const bytes = new Uint8Array([0, 0xff, 0x80, 65]);
    const response = byteReadResponse(new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
    const clone = response.clone();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    const blob = await clone.blob();
    expect(blob.type).toBe("application/octet-stream");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(clone.bodyUsed).toBe(true);
  });

  it("INV-6: retains URL-encoded and multipart formData readers", async () => {
    const encoded = byteReadResponse(
      new Response("name=Ada+Lovelace&tag=one&tag=two", {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    const values = await encoded.formData();
    expect(values.get("name")).toBe("Ada Lovelace");
    expect(values.getAll("tag")).toEqual(["one", "two"]);
    expect(encoded.bodyUsed).toBe(true);
    const form = new FormData();
    form.append("name", "世界");
    form.append("upload", new Blob([new Uint8Array([0, 255])], { type: "application/octet-stream" }), "bytes.bin");
    const multipart = byteReadResponse(new Response(form));
    const parsed = await multipart.formData();
    expect(parsed.get("name")).toBe("世界");
    const file = parsed.get("upload") as File;
    expect(file.name).toBe("bytes.bin");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255]));
    expect(multipart.bodyUsed).toBe(true);
  });
});
