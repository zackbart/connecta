// Lossless physical encoding only. Keep the compiler's existing schema sharing,
// and intern complete parameter rows, including descriptions and every flag.
// Repeated short schema fragments already compress well under ordinary gzip;
// sharing the larger parameter rows also removes repetition beyond its window.
export function compactIndex(data) {
  const { d, o } = JSON.parse(data.details);
  const parameters = [];
  const ids = new Map();
  const operations = o.map((row) =>
    row === 0
      ? 0
      : [
          row[0].map((parameter) => {
            const text = JSON.stringify(parameter);
            if (!ids.has(text)) {
              ids.set(text, parameters.length);
              parameters.push(text);
            }
            return ids.get(text);
          }),
          JSON.stringify(row[1]),
        ],
  );
  return { length: data.details.length, definitions: JSON.stringify(d), parameters, operations };
}
