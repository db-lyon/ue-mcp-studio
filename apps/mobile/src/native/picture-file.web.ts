/** picture-file.ts on the web harness and in tests: no file system, so the picture is a data URI. */
export async function keepPicture(chunks: AsyncIterable<Uint8Array>, type: string, progress?: (received: number) => void): Promise<string> {
  let bin = "";
  let received = 0;
  for await (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 0x8000) bin += String.fromCharCode(...chunk.subarray(i, i + 0x8000));
    received += chunk.byteLength;
    progress?.(received);
  }
  return `data:${type.split(";")[0].trim() || "image/png"};base64,${btoa(bin)}`;
}
