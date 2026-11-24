import { derive, validateManifest } from "./nva-core.js";
import { SpeechAtlasSource } from "./speech-atlas-source.js";
import { validateSpeechAtlasIndex } from "./speech-atlas-index.js";
import { SpeechVideoCache, drawBlendedFactorizedSpeechFrame, drawBlendedWholeHeadSpeechFrame } from "./speech-browser-runtime.js";
import { verifySpeechMotionBundle } from "./speech-bundle.js";
import { validateSpeechPlan } from "./speech-plan.js";
import { buildSpeechSchedule, prefetchSpeechRanges, resolveSpeechLayers, SpeechPlaybackState } from "./speech-runtime.js";

async function sha256Hex(blob) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requiredAsset(assets, path) {
  const blob = assets?.get?.(path);
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error(`missing NVA asset: ${path}`);
  return blob;
}

function abortError() {
  const error = new Error("SpeechPlayer was disposed during preparation");
  error.name = "AbortError";
  return error;
}

function waitForMedia(element, event = "loadeddata", signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      element.removeEventListener(event, loaded);
      element.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("NVA media decode failed")); };
    const aborted = () => { cleanup(); reject(abortError()); };
    if (signal?.aborted) return aborted();
    element.addEventListener(event, loaded, { once: true });
    element.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    element.load();
  });
}

export class SpeechPlayer {
  constructor({
    audio, canvas, bodyVideo, speechVideos,
    urlApi = globalThis.URL,
    imageLoader = globalThis.createImageBitmap,
    videoFactory,
    requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
    cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
  }) {
    if (!audio || !canvas || !bodyVideo) throw new TypeError("audio, canvas, and bodyVideo are required");
    if (typeof canvas.getContext !== "function") throw new TypeError("canvas must expose a 2D context");
    if (typeof imageLoader !== "function") throw new TypeError("an image loader is required");
    if (typeof requestFrame !== "function" || typeof cancelFrame !== "function")
      throw new TypeError("animation frame functions are required");
    this.audio = audio;
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true });
    if (!this.context) throw new TypeError("canvas must provide a 2D context");
    this.bodyVideo = bodyVideo;
    this.speechVideos = speechVideos;
    this.seedVideos = [bodyVideo, ...(Array.isArray(speechVideos) ? speechVideos : [])].filter(Boolean);
    this.usedVideos = new WeakSet();
    this.mediaContainer = bodyVideo.parentNode || this.seedVideos.find((video) => video.parentNode)?.parentNode || null;
    this.videoFactory = videoFactory || (() => {
      const document = bodyVideo.ownerDocument || globalThis.document;
      if (typeof document?.createElement !== "function") return null;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      if (video.style) video.style.display = "none";
      this.mediaContainer?.append?.(video);
      return video;
    });
    this.urlApi = urlApi;
    this.imageLoader = imageLoader;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.speechVideoCache = null;
    this.playbackState = new SpeechPlaybackState(
      () => this.state,
      (next) => { this.state = next; },
    );
    this.state = "empty";
    this.urls = [];
    this.audioUrl = null;
    this.bundleManifest = null;
    this.bundleAssets = null;
    this.bundleReady = false;
    this.pending = new Map();
    // Keys drawn in the latest frame are pinned while the bounded LRU cache
    // chooses another clip to release.
    this.onScreenKeys = new Set();
    this.transitionLoadQueue = Promise.resolve();
    this.prepareQueue = Promise.resolve();
    this.abortController = new AbortController();
    this.disposed = false;
    this.frameHandle = null;
    this.token = null;
    this.onEnded = () => this.stop("complete");
    this.onAudioError = () => this.stop("error");
    this.mode = null;
    this.externalClock = null;
  }

  load(options) {
    return this.#serializePrepare(() => this.#load(options));
  }

  async #load({ manifest, assets, plan, audioBlob }) {
    if (this.disposed) throw new Error("SpeechPlayer is disposed");
    if (plan?.quality_mode !== "aligned")
      throw new TypeError("audio playback requires an aligned SpeechPlan");
    if (!(audioBlob instanceof Blob) || audioBlob.size === 0) throw new TypeError("non-empty audio Blob is required");
    if (await sha256Hex(audioBlob) !== plan.audio?.sha256) throw new Error("SpeechPlan audio hash mismatch");
    await this.#loadMotion({ manifest, assets, plan });
    this.#throwIfDisposed();

    const audioUrl = this.#objectUrl(audioBlob);
    this.audio.src = audioUrl;
    const previousAudioUrl = this.audioUrl;
    this.audioUrl = audioUrl;
    if (previousAudioUrl) {
      const previousIndex = this.urls.indexOf(previousAudioUrl);
      if (previousIndex >= 0) this.urls.splice(previousIndex, 1);
      this.urlApi.revokeObjectURL(previousAudioUrl);
    }
    this.audio.preload = "auto";
    await waitForMedia(this.audio, "loadedmetadata", this.abortController.signal);
    const durationUs = Math.round(this.audio.duration * 1_000_000);
    if (!Number.isFinite(durationUs) || Math.abs(durationUs - plan.audio.duration_us) > 20_000)
      throw new Error("SpeechPlan audio duration mismatch");

    this.mode = "audio";
    this.audio.addEventListener("ended", this.onEnded);
    this.audio.addEventListener("error", this.onAudioError);
    this.state = "ready";
    this.#draw();
    return { quality_mode: plan.quality_mode, transitions: this.schedule.transitions.length };
  }

  loadExternal(options) {
    return this.#serializePrepare(() => this.#loadExternal(options));
  }

  async #loadExternal({ manifest, assets, plan }) {
    if (this.disposed) throw new Error("SpeechPlayer is disposed");
    if (plan?.quality_mode !== "browser-timed")
      throw new TypeError("external browser clock requires a browser-timed SpeechPlan");
    await this.#loadMotion({ manifest, assets, plan });
    this.#throwIfDisposed();
    this.mode = "external";
    this.state = "ready";
    this.#draw();
    return { quality_mode: plan.quality_mode, transitions: this.schedule.transitions.length };
  }

  // SoT 8: streamed speech (for example PCM chunks) has no audio Blob to hash,
  // but its time base is still that sound. An aligned plan is played against
  // the playback position of the sound that is actually playing. Timers and
  // character-count clocks are not audio clocks and must not be passed here.
  loadAudioClock(options) {
    return this.#serializePrepare(() => this.#loadAudioClock(options));
  }

  async #loadAudioClock({ manifest, assets, plan }) {
    if (this.disposed) throw new Error("SpeechPlayer is disposed");
    if (plan?.quality_mode !== "aligned")
      throw new TypeError("audio clock playback requires an aligned SpeechPlan");
    await this.#loadMotion({ manifest, assets, plan });
    this.#throwIfDisposed();
    this.mode = "audio-clock";
    this.state = "ready";
    this.#draw();
    return { quality_mode: plan.quality_mode, transitions: this.schedule.transitions.length };
  }

  // Browser speech reports word boundaries while it is already speaking, so a
  // browser-timed plan is revised during playback. The revision goes through
  // the same plan validation and buildSpeechSchedule as load; decoded atlas
  // slots, the body video, and the playback token are kept (SoT 5).
  updateExternalPlan(plan) {
    if (this.mode !== "external" || (this.state !== "ready" && this.state !== "speaking"))
      throw new Error("SpeechPlayer is not loaded for browser TTS playback");
    if (plan?.quality_mode !== "browser-timed")
      throw new TypeError("external browser clock requires a browser-timed SpeechPlan");
    const planValidation = validateSpeechPlan(plan);
    if (!planValidation.ok) throw new TypeError(`invalid SpeechPlan: ${planValidation.errors.join("; ")}`);
    const schedule = buildSpeechSchedule(plan, { availableKeys: Object.keys(this.atlasIndex.entries) });
    this.plan = plan;
    this.schedule = schedule;
    return { quality_mode: plan.quality_mode, transitions: schedule.transitions.length };
  }

  #serializePrepare(operation) {
    const result = this.prepareQueue.then(operation, operation);
    this.prepareQueue = result.catch(() => {});
    return result;
  }

  async #loadMotion({ manifest, assets, plan }) {
    this.stop("cancel");
    this.audio.removeEventListener?.("ended", this.onEnded);
    this.audio.removeEventListener?.("error", this.onAudioError);
    this.mode = null;
    this.state = "loading";
    const planValidation = validateSpeechPlan(plan);
    if (!planValidation.ok) throw new TypeError(`invalid SpeechPlan: ${planValidation.errors.join("; ")}`);

    await this.transitionLoadQueue.catch(() => {});
    this.#throwIfDisposed();
    this.onScreenKeys.clear();
    const sameBundle = this.bundleReady && this.bundleManifest === manifest && this.bundleAssets === assets;

    if (!sameBundle) {
      this.#releaseMedia();
      const clipFiles = [...assets.keys()];
      const manifestValidation = validateManifest(manifest, { clipFiles });
      if (!manifestValidation.ok) throw new TypeError(`invalid NVA: ${manifestValidation.errors.join("; ")}`);

      const speech = manifest.speech_motion;
      if (!speech) throw new Error("NVA has no speech_motion extension");
      const derived = derive(manifest);
      const talking = derived.talking;
      if (!talking) throw new Error("talking animation is required");

      const representation = speech.representation || "factorized-difference-layer";
      let region;
      if (representation === "whole-head-layer") {
        region = speech.region;
      } else {
        if (!Array.isArray(talking.ditto_region) || talking.ditto_region.length !== 4)
          throw new Error("talking animation requires ditto_region");
        region = talking.ditto_region;
      }

      const { atlasBlob, atlasIndex } = await verifySpeechMotionBundle(speech, assets);
      this.#throwIfDisposed();
      const indexValidation = validateSpeechAtlasIndex(atlasIndex, atlasBlob.size);
      if (!indexValidation.ok) throw new TypeError(`invalid speech atlas index: ${indexValidation.errors.join("; ")}`);

      this.manifest = manifest;
      this.assets = assets;
      this.atlasIndex = atlasIndex;
      this.atlasSource = new SpeechAtlasSource(atlasBlob);
      this.representation = representation;
      this.region = region;
      this.canvas.width = manifest.canvas.width;
      this.canvas.height = manifest.canvas.height;
      const neutralHead = await this.imageLoader.call(globalThis, requiredAsset(assets, speech.neutral_head));
      this.#throwIfDisposed();
      this.neutralHead = neutralHead;

      const bodyVideo = this.#newVideo();
      const bodyUrl = this.#objectUrl(requiredAsset(assets, talking.clip));
      bodyVideo.preload = "auto";
      bodyVideo.muted = true;
      bodyVideo.loop = true;
      bodyVideo.playsInline = true;
      this.bodyVideo = bodyVideo;
      bodyVideo.src = bodyUrl;
      await waitForMedia(bodyVideo, "loadeddata", this.abortController.signal);
      this.#throwIfDisposed();
      this.speechVideoCache = new SpeechVideoCache({
        videoFactory: () => this.#newVideo(),
        activateVideo: (video) => this.mediaContainer?.append?.(video),
        urlApi: this.urlApi,
        maxEntries: Math.max(1, Object.keys(atlasIndex.entries).length),
        maxActiveEntries: Math.min(3, Math.max(1, Object.keys(atlasIndex.entries).length)),
        isProtected: (key) => this.onScreenKeys.has(key),
      });
      this.bundleManifest = manifest;
      this.bundleAssets = assets;
      this.bundleReady = true;
    } else {
      this.manifest = manifest;
      this.assets = assets;
    }

    this.plan = plan;
    this.schedule = buildSpeechSchedule(plan, { availableKeys: Object.keys(this.atlasIndex.entries) });
    for (const range of prefetchSpeechRanges(this.schedule, this.atlasIndex)) {
      const index = this.schedule.transitions.findIndex((item) => item.key === range.key);
      if (index >= 0) await this.#ensureTransition(index);
    }
  }

  async play() {
    if (this.state !== "ready") throw new Error("SpeechPlayer is not ready");
    if (this.mode === "external" || this.mode === "audio-clock")
      throw new Error("SpeechPlayer is not loaded for audio playback");
    this.token = this.playbackState.begin("speaking");
    this.audio.currentTime = 0;
    this.bodyVideo.currentTime = 0;
    try {
      await this.bodyVideo.play();
      await this.audio.play();
      this.#tick();
    } catch (error) {
      this.stop("error");
      throw error;
    }
  }

  async playExternal(clock) {
    if (this.mode !== "external" && this.state === "ready")
      throw new Error("SpeechPlayer is not loaded for browser TTS playback");
    return this.#playWithClock(clock);
  }

  // clock() returns the playback position, in seconds, of the streamed sound
  // the aligned plan was made for.
  async playAudioClock(clock) {
    if (this.mode !== "audio-clock" && this.state === "ready")
      throw new Error("SpeechPlayer is not loaded for audio clock playback");
    return this.#playWithClock(clock);
  }

  async #playWithClock(clock) {
    if (this.state !== "ready") throw new Error("SpeechPlayer is not ready");
    if (typeof clock !== "function") throw new TypeError("external clock function is required");
    this.externalClock = clock;
    this.token = this.playbackState.begin("speaking");
    this.bodyVideo.currentTime = 0;
    try {
      await this.bodyVideo.play();
      this.#tick();
    } catch (error) {
      this.stop("error");
      throw error;
    }
  }

  stop(outcome = "cancel") {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.audio?.pause?.();
    this.bodyVideo?.pause?.();
    if (this.token) this.playbackState.settle(this.token, outcome);
    this.token = null;
    this.externalClock = null;
    if (this.state === "speaking") this.state = "ready";
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort();
    this.stop("cancel");
    this.audio.removeEventListener?.("ended", this.onEnded);
    this.audio.removeEventListener?.("error", this.onAudioError);
    this.#releaseMedia();
    this.state = "disposed";
  }

  #objectUrl(blob) {
    const url = this.urlApi.createObjectURL(blob);
    this.urls.push(url);
    return url;
  }

  #releaseMedia() {
    for (const url of this.urls.splice(0)) this.urlApi.revokeObjectURL(url);
    this.speechVideoCache?.dispose();
    this.speechVideoCache = null;
    if (this.bodyVideo && this.usedVideos.has(this.bodyVideo)) {
      this.bodyVideo.pause?.();
      this.#detachVideo(this.bodyVideo);
    }
    this.neutralHead?.close?.();
    this.neutralHead = null;
    this.bodyVideo = null;
    this.audioUrl = null;
    this.bundleManifest = null;
    this.bundleAssets = null;
    this.bundleReady = false;
    this.manifest = null;
    this.assets = null;
    this.atlasIndex = null;
    this.atlasSource = null;
    this.pending.clear();
    this.onScreenKeys.clear();
  }

  #newVideo() {
    while (this.seedVideos.length) {
      const video = this.seedVideos.shift();
      if (this.usedVideos.has(video)) continue;
      this.usedVideos.add(video);
      return video;
    }
    const video = this.videoFactory();
    if (!video || this.usedVideos.has(video))
      throw new TypeError("videoFactory must return a new video element");
    this.usedVideos.add(video);
    return video;
  }

  #detachVideo(video) {
    if (typeof video?.remove === "function") video.remove();
    else if (video?.parentNode && typeof video.parentNode.removeChild === "function")
      video.parentNode.removeChild(video);
  }

  async #ensureTransition(index) {
    const transition = this.schedule.transitions[index];
    if (!transition || !this.speechVideoCache) return null;
    const cached = this.speechVideoCache.get(transition.key);
    if (cached) return cached;
    if (this.pending.has(transition.key)) return this.pending.get(transition.key);
    const entry = this.atlasIndex.entries[transition.key];
    const load = this.transitionLoadQueue.then(async () => {
      const alreadyLoaded = this.speechVideoCache.get(transition.key);
      if (alreadyLoaded) return alreadyLoaded;
      if (!this.speechVideoCache.canLoad(transition.key)) return null;
      const blob = await this.atlasSource.read(entry.offset, entry.offset + entry.length);
      this.#throwIfDisposed();
      return this.speechVideoCache.load(transition.key, blob);
    });
    const promise = load.finally(() => {
      this.pending.delete(transition.key);
    });
    this.pending.set(transition.key, promise);
    this.transitionLoadQueue = promise.catch(() => {});
    return promise;
  }

  #throwIfDisposed() {
    if (this.disposed) throw abortError();
  }

  #tick() {
    if (this.state !== "speaking") return;
    this.#draw();
    this.frameHandle = this.requestFrame(() => this.#tick());
  }

  #draw() {
    if (!this.manifest || this.bodyVideo.readyState < 2) return;
    const seconds = this.mode === "external" || this.mode === "audio-clock"
      ? (this.externalClock?.() || 0)
      : (this.audio.currentTime || 0);
    const timeUs = Math.min(this.schedule.duration_us, Math.max(0, Math.round(seconds * 1_000_000)));
    const resolved = resolveSpeechLayers(this.schedule, timeUs);
    this.onScreenKeys = new Set(resolved.map((layer) => layer.key));
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.drawImage(this.bodyVideo, 0, 0, this.canvas.width, this.canvas.height);
    const readyLayers = [];
    for (const layer of resolved) {
      let video;
      try {
        video = this.speechVideoCache?.get(layer.key);
      } catch {
        this.stop("error");
        return;
      }
      if (!video) {
        void this.#ensureTransition(layer.index).catch(() => this.stop("error"));
        continue;
      }
      const targetTime = layer.frame / 25;
      if (Math.abs((video.currentTime || 0) - targetTime) > 0.005) video.currentTime = targetTime;
      readyLayers.push({ image: video, opacity: layer.opacity });
    }
    if (this.representation === "whole-head-layer") {
      drawBlendedWholeHeadSpeechFrame(this.context, this.neutralHead, readyLayers, this.region);
    } else {
      drawBlendedFactorizedSpeechFrame(this.context, this.neutralHead, readyLayers, this.region);
    }

    const current = resolved[0]?.index;
    if (resolved.length === 1 && Number.isInteger(current))
      void this.#ensureTransition(Math.min(current + 1, this.schedule.transitions.length - 1))
        .catch(() => this.stop("error"));
  }
}
