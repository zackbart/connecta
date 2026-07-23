/** Build a dependency-free 32px ICO matching the default SVG "C" mark. */
function buildIco(): Uint8Array {
  const size = 32;
  const directoryLength = 22;
  const bitmapHeaderLength = 40;
  const colorLength = size * size * 4;
  const maskRowLength = 4;
  const maskLength = maskRowLength * size;
  const imageLength = bitmapHeaderLength + colorLength + maskLength;
  const ico = new Uint8Array(directoryLength + imageLength);
  const view = new DataView(ico.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // image type: icon
  view.setUint16(4, 1, true); // image count
  ico[6] = size;
  ico[7] = size;
  view.setUint16(10, 1, true); // color planes
  view.setUint16(12, 32, true); // bits per pixel
  view.setUint32(14, imageLength, true);
  view.setUint32(18, directoryLength, true);

  const dib = directoryLength;
  view.setUint32(dib, bitmapHeaderLength, true);
  view.setInt32(dib + 4, size, true);
  view.setInt32(dib + 8, size * 2, true); // color image + transparency mask
  view.setUint16(dib + 12, 1, true);
  view.setUint16(dib + 14, 32, true);
  view.setUint32(dib + 20, colorLength, true);

  const pixels = dib + bitmapHeaderLength;
  const mask = pixels + colorLength;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - 15.5;
      const dy = y - 15.5;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const opaque = radius >= 8 && radius <= 13 &&
        (x <= 18 || Math.abs(dy) >= 7);
      const row = size - 1 - y;
      const pixel = pixels + (row * size + x) * 4;
      ico[pixel + 3] = opaque ? 255 : 0;
      if (!opaque) {
        ico[mask + row * maskRowLength + Math.floor(x / 8)] |=
          0x80 >> (x % 8);
      }
    }
  }

  return ico;
}

export const CONNECTA_FAVICON_ICO = buildIco();
