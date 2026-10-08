// Web-API only, like the rest of the core: Node and workerd read a body alike.

const decoder = new TextDecoder();

/**
 * A downstream's response whose `text()` and `json()` read bytes.
 *
 * workerd, when `.text()` (and `.json()`, which reads text) meets a body whose
 * Content-Type it does not parse as text, prints a native warning quoting that
 * Content-Type whole: below every console and logger, so a downstream could
 * write into the deployment's log (INV-6, #695). No filter on the header can
 * agree with workerd's own parser for every value a downstream can send, so
 * connecta never asks for text: `arrayBuffer()` carries no such warning, and
 * the bytes are decoded here exactly as `text()` would decode them (UTF-8,
 * BOM stripped, malformed sequences replaced).
 *
 * The response itself is returned, its readers shadowed by own properties, so
 * `status`, `headers`, `url`, `body`, and `instanceof Response` are unchanged,
 * and so is everything an SDK or a handler reads. A clone is shadowed too:
 * the pinned SDK reads a token response's `clone().json()`.
 */
export function byteReadResponse(response: Response): Response {
  if (!Object.isExtensible(response)) {
    // A custom fetch that froze its response: shadow a copy instead, which
    // keeps everything but `url` and `redirected`.
    return byteReadResponse(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    );
  }
  const arrayBuffer = response.arrayBuffer.bind(response);
  const clone = response.clone.bind(response);
  const text = async (): Promise<string> => decoder.decode(await arrayBuffer());
  const own = (value: unknown): PropertyDescriptor => ({ value, configurable: true, writable: true });
  return Object.defineProperties(response, {
    text: own(text),
    json: own(async (): Promise<unknown> => JSON.parse(await text())),
    clone: own(() => byteReadResponse(clone())),
  });
}
