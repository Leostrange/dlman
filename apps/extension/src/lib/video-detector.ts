/**
 * Video Detector — observes DOM and network for media streams.
 *
 * Detection strategies:
 * 1. DOM Observer: Watches for <video>, <source>, <audio> elements
 * 2. Source Sniffing: Monitors element src/currentSrc changes
 * 3. Network Intercept: Hooks into XHR/fetch to detect .m3u8/.mpd URLs
 *
 * Architecture:
 * - Runs in content script context
 * - Emits detected media via callback
 * - Deduplicates by URL
 * - Cleans up on page unload
 */

import type { DetectedMedia, MediaProtocol } from './media-types';

// ============================================================================
// Constants
// ============================================================================

/** File extensions that indicate direct video files */
const DIRECT_VIDEO_EXTENSIONS = /\.(mp4|webm|mkv|avi|mov|m4v|flv|wmv|ogv)(\?|#|$)/i;

/** File extensions that indicate direct audio files */
const DIRECT_AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;

/** URL patterns for HLS manifests */
const HLS_PATTERN = /\.m3u8(\?|#|$)/i;

/** URL patterns for DASH manifests */
const DASH_PATTERN = /\.mpd(\?|#|$)/i;

/** MIME types that indicate media content */
const MEDIA_MIME_TYPES: Record<string, MediaProtocol> = {
  'application/vnd.apple.mpegurl': 'hls',
  'application/x-mpegurl': 'hls',
  'audio/mpegurl': 'hls',
  'audio/x-mpegurl': 'hls',
  'application/dash+xml': 'dash',
  'video/mp4': 'direct',
  'video/webm': 'direct',
  'video/ogg': 'direct',
  'audio/mpeg': 'direct',
  'audio/mp4': 'direct',
  'audio/ogg': 'direct',
  'audio/webm': 'direct',
};

/** Minimum video duration (seconds) to consider for detection — filters out ads */
const MIN_DURATION_SECONDS = 10;

// ============================================================================
// URL Classification
// ============================================================================

/** Determine the media protocol from a URL */
function classifyUrl(url: string): MediaProtocol | null {
  if (HLS_PATTERN.test(url)) return 'hls';
  if (DASH_PATTERN.test(url)) return 'dash';
  if (DIRECT_VIDEO_EXTENSIONS.test(url)) return 'direct';
  if (DIRECT_AUDIO_EXTENSIONS.test(url)) return 'direct';
  return null;
}

/** Determine protocol from MIME type */
function classifyMime(mime: string): MediaProtocol | null {
  const normalized = mime.toLowerCase().split(';')[0].trim();
  return MEDIA_MIME_TYPES[normalized] ?? null;
}

/** Generate a stable ID for a detected URL (for dedup) */
function mediaId(url: string): string {
  // Strip query params for dedup — same base URL = same media
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Extract a suggested filename from a URL */
function suggestFilename(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const segment = pathname.split('/').pop();
    if (segment && segment.includes('.')) {
      return decodeURIComponent(segment.split('?')[0]);
    }
  } catch {
    // ignore
  }
  return undefined;
}

// ============================================================================
// VideoDetector Class
// ============================================================================

export type OnMediaDetected = (media: DetectedMedia) => void;

export interface VideoDetectorOptions {
  /** Called when new media is detected */
  onDetected: OnMediaDetected;
  /** Minimum video duration in seconds to detect (default: 10) */
  minDuration?: number;
  /** Whether to intercept network requests (default: true) */
  interceptNetwork?: boolean;
  /** Whether to observe DOM mutations (default: true) */
  observeDOM?: boolean;
}

export class VideoDetector {
  private options: Required<VideoDetectorOptions>;
  private seenUrls = new Set<string>();
  private observer: MutationObserver | null = null;
  private cleanupFns: Array<() => void> = [];
  private destroyed = false;

  constructor(options: VideoDetectorOptions) {
    this.options = {
      onDetected: options.onDetected,
      minDuration: options.minDuration ?? MIN_DURATION_SECONDS,
      interceptNetwork: options.interceptNetwork ?? true,
      observeDOM: options.observeDOM ?? true,
    };
  }

  /** Start all detection strategies */
  start(): void {
    if (this.destroyed) return;

    // Strategy 1: Scan existing elements
    this.scanExistingElements();

    // Strategy 2: Observe DOM mutations
    if (this.options.observeDOM) {
      this.startDOMObserver();
    }

    // Strategy 3: Intercept network requests
    if (this.options.interceptNetwork) {
      this.startNetworkIntercept();
    }

    // Strategy 4: Listen for video element events
    this.startVideoEventListeners();
  }

  /** Stop all detection and clean up */
  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns = [];
    this.seenUrls.clear();
  }

  // ==========================================================================
  // Strategy 1: Scan existing DOM elements
  // ==========================================================================

  private scanExistingElements(): void {
    // Scan <video> elements
    document.querySelectorAll('video').forEach((video) => {
      this.processVideoElement(video as HTMLVideoElement);
    });

    // Scan <audio> elements
    document.querySelectorAll('audio').forEach((audio) => {
      this.processAudioElement(audio as HTMLAudioElement);
    });

    // Scan <source> elements outside of <video>/<audio>
    document.querySelectorAll('source').forEach((source) => {
      const src = (source as HTMLSourceElement).src;
      const type = (source as HTMLSourceElement).type;
      if (src) {
        this.processMediaUrl(src, type || undefined);
      }
    });
  }

  // ==========================================================================
  // Strategy 2: DOM Mutation Observer
  // ==========================================================================

  private startDOMObserver(): void {
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // New nodes added
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;

          if (el.tagName === 'VIDEO') {
            this.processVideoElement(el as HTMLVideoElement);
          } else if (el.tagName === 'AUDIO') {
            this.processAudioElement(el as HTMLAudioElement);
          } else if (el.tagName === 'SOURCE') {
            const src = (el as HTMLSourceElement).src;
            const type = (el as HTMLSourceElement).type;
            if (src) this.processMediaUrl(src, type || undefined);
          }

          // Also check descendants
          el.querySelectorAll?.('video')?.forEach((v) => {
            this.processVideoElement(v as HTMLVideoElement);
          });
          el.querySelectorAll?.('audio')?.forEach((a) => {
            this.processAudioElement(a as HTMLAudioElement);
          });
        }

        // Attribute changes (e.g., src changed)
        if (mutation.type === 'attributes' && mutation.target.nodeType === Node.ELEMENT_NODE) {
          const el = mutation.target as Element;
          if (el.tagName === 'VIDEO' && mutation.attributeName === 'src') {
            this.processVideoElement(el as HTMLVideoElement);
          } else if (el.tagName === 'SOURCE' && mutation.attributeName === 'src') {
            const src = (el as HTMLSourceElement).src;
            if (src) this.processMediaUrl(src, (el as HTMLSourceElement).type || undefined);
          }
        }
      }
    });

    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'currentSrc'],
    });
  }

  // ==========================================================================
  // Strategy 3: Network Request Interception
  // ==========================================================================

  private startNetworkIntercept(): void {
    // Hook XMLHttpRequest
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const detector = this;

    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: any[]
    ) {
      const urlStr = url.toString();
      detector.processMediaUrl(urlStr);
      return origXhrOpen.apply(this, [method, url, ...rest] as any);
    };

    this.cleanupFns.push(() => {
      XMLHttpRequest.prototype.open = origXhrOpen;
    });

    // Hook fetch
    const origFetch = window.fetch;

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      let url: string | undefined;
      if (typeof input === 'string') {
        url = input;
      } else if (input instanceof URL) {
        url = input.toString();
      } else if (input instanceof Request) {
        url = input.url;
      }
      if (url) {
        detector.processMediaUrl(url);
      }
      return origFetch.call(this, input, init);
    };

    this.cleanupFns.push(() => {
      window.fetch = origFetch;
    });
  }

  // ==========================================================================
  // Strategy 4: Video element event listeners
  // ==========================================================================

  private startVideoEventListeners(): void {
    // Listen for 'loadedmetadata' on the document (bubbles up from <video>)
    const handler = (e: Event) => {
      const target = e.target;
      if (target instanceof HTMLVideoElement) {
        this.processVideoElement(target);
      } else if (target instanceof HTMLAudioElement) {
        this.processAudioElement(target);
      }
    };

    document.addEventListener('loadedmetadata', handler, true);
    document.addEventListener('canplay', handler, true);

    this.cleanupFns.push(() => {
      document.removeEventListener('loadedmetadata', handler, true);
      document.removeEventListener('canplay', handler, true);
    });
  }

  // ==========================================================================
  // Element Processing
  // ==========================================================================

  private processVideoElement(video: HTMLVideoElement): void {
    // Check currentSrc first (actual playing source), then src attribute
    const url = video.currentSrc || video.src;
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) {
      // For blob URLs, check <source> children
      video.querySelectorAll('source').forEach((source) => {
        const src = (source as HTMLSourceElement).src;
        const type = (source as HTMLSourceElement).type;
        if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
          this.processMediaUrl(src, type || undefined, video);
        }
      });
      return;
    }

    // Filter out very short videos (likely ads or previews)
    if (video.duration && video.duration < this.options.minDuration) {
      return;
    }

    this.processMediaUrl(url, undefined, video);
  }

  private processAudioElement(audio: HTMLAudioElement): void {
    const url = audio.currentSrc || audio.src;
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    this.processMediaUrl(url);
  }

  // ==========================================================================
  // Core URL Processing
  // ==========================================================================

  private processMediaUrl(
    url: string,
    mimeType?: string,
    videoElement?: HTMLVideoElement,
  ): void {
    if (this.destroyed) return;

    // Determine protocol
    let protocol: MediaProtocol | null = classifyUrl(url);
    if (!protocol && mimeType) {
      protocol = classifyMime(mimeType);
    }
    if (!protocol) return; // Not a recognized media URL

    // Dedup
    const id = mediaId(url);
    if (this.seenUrls.has(id)) return;
    this.seenUrls.add(id);

    // Build detection result
    const media: DetectedMedia = {
      id,
      page_url: window.location.href,
      page_title: document.title || undefined,
      master_url: url,
      protocol,
      variants: [],
      mime_type: mimeType,
      filename: suggestFilename(url),
      duration: videoElement?.duration && Number.isFinite(videoElement.duration)
        ? videoElement.duration
        : undefined,
      thumbnail: videoElement ? this.extractThumbnail(videoElement) : undefined,
      referrer: document.referrer || window.location.href,
    };

    // If we have the video element, store its position for overlay
    if (videoElement) {
      media.element_rect = videoElement.getBoundingClientRect();
    }

    this.options.onDetected(media);
  }

  /** Try to extract a poster or thumbnail from a video element */
  private extractThumbnail(video: HTMLVideoElement): string | undefined {
    if (video.poster && !video.poster.startsWith('data:')) {
      return video.poster;
    }
    return undefined;
  }
}
