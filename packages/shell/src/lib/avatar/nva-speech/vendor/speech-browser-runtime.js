export function drawFactorizedSpeechFrame(context, neutralHead, speechLayer, region) {
  if (!context || typeof context.drawImage !== "function") throw new TypeError("2D canvas context is required");
  if (!Array.isArray(region) || region.length !== 4) throw new TypeError("region must be [x,y,width,height]");
  const previousOperation = context.globalCompositeOperation;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.drawImage(neutralHead, ...region);
  context.drawImage(speechLayer, ...region);
  context.restore();
  // Minimal mock contexts do not implement save/restore state semantics.
  context.globalCompositeOperation = previousOperation;
}

export function drawBlendedFactorizedSpeechFrame(context, neutralHead, layers, region) {
  if (!context || typeof context.drawImage !== "function") throw new TypeError("2D canvas context is required");
  if (!Array.isArray(region) || region.length !== 4) throw new TypeError("region must be [x,y,width,height]");
  if (!Array.isArray(layers) || layers.length > 2) throw new TypeError("at most two speech layers are supported");
  const previousOperation = context.globalCompositeOperation;
  const previousAlpha = context.globalAlpha;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.drawImage(neutralHead, ...region);
  for (const layer of layers) {
    if (!layer?.image || typeof layer.opacity !== "number" || layer.opacity < 0 || layer.opacity > 1)
      throw new TypeError("speech layer image and opacity are required");
    if (layer.opacity === 0) continue;
    context.globalAlpha = layer.opacity;
    context.drawImage(layer.image, ...region);
  }
  context.restore();
  context.globalCompositeOperation = previousOperation;
  context.globalAlpha = previousAlpha;
}

export function drawBlendedWholeHeadSpeechFrame(context, neutralHead, layers, region) {
  if (!context || typeof context.drawImage !== "function") throw new TypeError("2D canvas context is required");
  if (!Array.isArray(region) || region.length !== 4) throw new TypeError("region must be [x,y,width,height]");
  if (!Array.isArray(layers) || layers.length > 2) throw new TypeError("at most two speech layers are supported");
  const previousOperation = context.globalCompositeOperation;
  const previousAlpha = context.globalAlpha;
  context.save?.();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.drawImage(neutralHead, ...region);
  if (layers.length > 0) {
    const first = layers[0];
    if (!first?.image) throw new TypeError("speech layer image is required");
    context.globalAlpha = 1;
    context.drawImage(first.image, ...region);
  }
  if (layers.length > 1) {
    const second = layers[1];
    if (!second?.image || typeof second.opacity !== "number" || second.opacity < 0 || second.opacity > 1)
      throw new TypeError("speech layer image and opacity are required");
    if (second.opacity > 0) {
      context.globalAlpha = second.opacity;
      context.drawImage(second.image, ...region);
    }
  }
  context.restore?.();
  context.globalCompositeOperation = previousOperation;
  context.globalAlpha = previousAlpha;
}

function detachVideo(video) {
  if (typeof video?.remove === "function") {
    video.remove();
  } else if (video?.parentNode && typeof video.parentNode.removeChild === "function") {
    video.parentNode.removeChild(video);
  }
}

function abortError() {
  const error = new Error("speech video load was cancelled");
  error.name = "AbortError";
  return error;
}

export class SpeechVideoCache {
  constructor({
    videoFactory,
    activateVideo = () => {},
    urlApi = globalThis.URL,
    maxEntries = 3,
    maxActiveEntries = maxEntries,
    isProtected = () => false,
  } = {}) {
    if (typeof videoFactory !== "function") throw new TypeError("videoFactory is required");
    if (typeof activateVideo !== "function") throw new TypeError("activateVideo must be a function");
    if (typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function")
      throw new TypeError("object URL API is required");
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new TypeError("maxEntries must be a positive integer");
    if (!Number.isSafeInteger(maxActiveEntries) || maxActiveEntries < 1 || maxActiveEntries > maxEntries)
      throw new TypeError("maxActiveEntries must be a positive integer no greater than maxEntries");
    if (typeof isProtected !== "function") throw new TypeError("isProtected must be a function");
    this.videoFactory = videoFactory;
    this.activateVideo = activateVideo;
    this.urlApi = urlApi;
    this.maxEntries = maxEntries;
    this.maxActiveEntries = maxActiveEntries;
    this.isProtected = isProtected;
    this.entries = new Map();
    this.videoKeys = new WeakMap();
    this.useSequence = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.loading) return null;
    if (entry.failed) throw entry.failed;
    if (!this.#activate(entry)) return null;
    entry.lastUsed = ++this.useSequence;
    return entry.video;
  }

  has(key) {
    return this.entries.has(key);
  }

  canLoad(key) {
    const existing = this.entries.get(key);
    if (existing) return !existing.failed && (existing.active || this.#canActivate());
    return this.entries.size < this.maxEntries && this.#canActivate();
  }

  async load(key, blob) {
    if (typeof key !== "string" || !key) throw new TypeError("speech clip key is required");
    if (!(blob instanceof Blob) || blob.size === 0) throw new TypeError("non-empty WebM Blob is required");
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.failed) throw existing.failed;
      if (existing.loading) return existing.promise;
      if (!this.#activate(existing)) return null;
      existing.lastUsed = ++this.useSequence;
      return existing.video;
    }

    if (this.entries.size >= this.maxEntries || !this.#makeActiveSlot()) return null;

    const video = this.videoFactory();
    if (!video) throw new TypeError("videoFactory did not return a video element");
    if (this.videoKeys.has(video)) throw new TypeError("each speech clip requires a distinct video element");
    this.videoKeys.set(video, key);
    const url = this.urlApi.createObjectURL(blob);
    const entry = {
      key, video, url, lastUsed: ++this.useSequence, loading: true,
      promise: null, cancel: null, active: true, failed: null, urlRevoked: false, released: false,
    };
    this.entries.set(key, entry);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    entry.promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("error", failed);
        entry.cancel = null;
      };
      const loaded = () => { cleanup(); resolve(video); };
      const failed = () => { cleanup(); reject(new Error("speech unit decode failed")); };
      entry.cancel = () => { cleanup(); reject(abortError()); };
      video.addEventListener("loadeddata", loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.load();
    }).then((loadedVideo) => {
      entry.loading = false;
      entry.promise = null;
      return loadedVideo;
    }).catch((error) => {
      entry.loading = false;
      entry.promise = null;
      entry.failed = error;
      this.#deactivate(entry);
      this.#revoke(entry);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  dispose() {
    for (const entry of this.entries.values()) {
      entry.cancel?.();
      this.#release(entry);
    }
    this.entries.clear();
  }

  #release(entry) {
    if (entry.released) return;
    entry.released = true;
    this.#deactivate(entry);
    this.#revoke(entry);
  }

  #revoke(entry) {
    if (entry.urlRevoked) return;
    entry.urlRevoked = true;
    this.urlApi.revokeObjectURL(entry.url);
  }

  #deactivate(entry) {
    if (!entry.active) return;
    entry.video.pause?.();
    detachVideo(entry.video);
    entry.active = false;
  }

  #activate(entry) {
    if (entry.active) return true;
    if (!this.#makeActiveSlot()) return false;
    this.activateVideo(entry.video);
    entry.active = true;
    return true;
  }

  #canActivate() {
    const activeEntries = [...this.entries.values()].filter((entry) => entry.active);
    return activeEntries.length < this.maxActiveEntries
      || activeEntries.some((entry) => !entry.loading && !this.isProtected(entry.key));
  }

  #makeActiveSlot() {
    while ([...this.entries.values()].filter((entry) => entry.active).length >= this.maxActiveEntries) {
      const victim = [...this.entries.values()]
        .filter((entry) => entry.active && !entry.loading && !this.isProtected(entry.key))
        .sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!victim) return false;
      this.#deactivate(victim);
    }
    return true;
  }
}
