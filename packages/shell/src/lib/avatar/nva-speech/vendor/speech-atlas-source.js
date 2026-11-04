// Unified byte source for an uncompressed atlas entry inside an NVA bundle.
// `end` is exclusive, matching Blob.slice; HTTP Range conversion is internal.
export class SpeechAtlasSource {
  constructor(source, fetchImplementation = globalThis.fetch) {
    if (!(source instanceof Blob) && (typeof source !== "string" || !source))
      throw new TypeError("atlas source must be a Blob or URL");
    if (typeof source === "string" && typeof fetchImplementation !== "function")
      throw new TypeError("fetch implementation is required for URL sources");
    this.source = source;
    this.fetch = fetchImplementation;
    this.rangeSupported = source instanceof Blob ? true : null;
    this.fullBlob = source instanceof Blob ? source : null;
    this.fullBlobPromise = null;
  }

  async read(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      throw new RangeError("invalid byte range");
    if (this.fullBlob) return this.#sliceFull(start, end);

    const response = await this.fetch.call(globalThis, this.source, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (response.status === 206) {
      const expected = `bytes ${start}-${end - 1}/`;
      const contentRange = response.headers.get("Content-Range") || "";
      const blob = await response.blob();
      if (!contentRange.startsWith(expected) || blob.size !== end - start)
        throw new Error("invalid HTTP 206 range response");
      this.rangeSupported = true;
      return blob;
    }
    if (response.status !== 200) throw new Error(`atlas HTTP ${response.status}`);

    this.rangeSupported = false;
    if (!this.fullBlobPromise) this.fullBlobPromise = response.blob();
    this.fullBlob = await this.fullBlobPromise;
    return this.#sliceFull(start, end);
  }

  #sliceFull(start, end) {
    if (end > this.fullBlob.size) throw new RangeError("byte range exceeds atlas size");
    return this.fullBlob.slice(start, end, "video/webm");
  }
}
