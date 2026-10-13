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

export class AlternatingSpeechDecoder {
  constructor(videos, urlApi = globalThis.URL) {
    if (!Array.isArray(videos) || videos.length !== 2 || videos.some((video) => !video))
      throw new TypeError("exactly two video elements are required");
    if (typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function")
      throw new TypeError("object URL API is required");
    this.videos = videos;
    this.urlApi = urlApi;
    this.urls = [null, null];
    this.nextSlot = 0;
  }

  async load(blob) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new TypeError("non-empty WebM Blob is required");
    const slot = this.nextSlot;
    this.nextSlot = (this.nextSlot + 1) % 2;
    const video = this.videos[slot];
    if (this.urls[slot]) this.urlApi.revokeObjectURL(this.urls[slot]);
    const url = this.urlApi.createObjectURL(blob);
    this.urls[slot] = url;
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener("loadeddata", loaded);
        video.removeEventListener("error", failed);
      };
      const loaded = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("speech unit decode failed")); };
      video.addEventListener("loadeddata", loaded, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.load();
    });
    return { slot, video, url };
  }

  dispose() {
    for (let slot = 0; slot < this.urls.length; slot++) {
      if (this.urls[slot]) this.urlApi.revokeObjectURL(this.urls[slot]);
      this.urls[slot] = null;
      this.videos[slot].removeAttribute?.("src");
      this.videos[slot].load?.();
    }
  }
}
