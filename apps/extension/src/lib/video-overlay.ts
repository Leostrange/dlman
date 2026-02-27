/**
 * Video Overlay — sticky download button on detected <video> elements.
 *
 * Renders a floating download button (IDM-style) on each detected video.
 * When clicked, shows a quality picker if multiple variants are available,
 * then sends the download request to the background script.
 *
 * Architecture:
 * - DOM is injected directly (no React — content scripts must be lightweight)
 * - Styles are scoped via unique class prefix to avoid page conflicts
 * - Overlay repositions on scroll/resize
 * - Each video gets at most one overlay instance
 *
 * Why not Shadow DOM?
 * - Firefox MV2 content scripts have limited Shadow DOM support
 * - Direct injection with scoped classes is simpler and cross-browser
 */

import type { DetectedMedia, MediaVariant, MediaDownloadRequest } from './media-types';

// ============================================================================
// Constants
// ============================================================================

const PREFIX = 'dlman-vo'; // Scoped class prefix: dlman-video-overlay
const OVERLAY_ATTR = 'data-dlman-overlay-id';
const Z_INDEX = 2147483646; // Just below toast container

// ============================================================================
// Style Injection
// ============================================================================

let styleInjected = false;

function injectStyles(): void {
  if (styleInjected) return;
  styleInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    .${PREFIX}-btn {
      position: absolute;
      z-index: ${Z_INDEX};
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      background: linear-gradient(135deg, #1e3a5f 0%, #0f1f36 100%);
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      border: 1px solid rgba(59, 130, 246, 0.3);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(59, 130, 246, 0.15);
      cursor: pointer;
      user-select: none;
      pointer-events: auto;
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 0.25s ease, transform 0.25s ease, background 0.15s ease;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      white-space: nowrap;
    }

    .${PREFIX}-btn.${PREFIX}-visible {
      opacity: 1;
      transform: translateY(0);
    }

    .${PREFIX}-btn:hover {
      background: linear-gradient(135deg, #2563eb 0%, #1e3a5f 100%);
      border-color: rgba(59, 130, 246, 0.6);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(59, 130, 246, 0.3);
    }

    .${PREFIX}-btn:active {
      transform: scale(0.97);
    }

    .${PREFIX}-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .${PREFIX}-dropdown {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: ${Z_INDEX + 1};
      min-width: 200px;
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border: 1px solid rgba(59, 130, 246, 0.25);
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
      padding: 6px 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      opacity: 0;
      transform: translateY(-4px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }

    .${PREFIX}-dropdown.${PREFIX}-open {
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    .${PREFIX}-dropdown-title {
      padding: 8px 14px 6px;
      font-size: 11px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .${PREFIX}-dropdown-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 14px;
      font-size: 13px;
      color: #e2e8f0;
      cursor: pointer;
      transition: background 0.12s ease;
    }

    .${PREFIX}-dropdown-item:hover {
      background: rgba(59, 130, 246, 0.15);
    }

    .${PREFIX}-dropdown-item-label {
      font-weight: 600;
    }

    .${PREFIX}-dropdown-item-meta {
      font-size: 11px;
      color: #64748b;
    }

    .${PREFIX}-dropdown-divider {
      height: 1px;
      background: rgba(59, 130, 246, 0.15);
      margin: 4px 0;
    }
  `;
  document.documentElement.appendChild(style);
}

// ============================================================================
// SVG Icons
// ============================================================================

function downloadIconSVG(): string {
  return `<svg class="${PREFIX}-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function chevronDownSVG(): string {
  return `<svg class="${PREFIX}-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
}

// ============================================================================
// Video Overlay Manager
// ============================================================================

export type OnDownloadRequest = (request: MediaDownloadRequest) => void;

interface OverlayInstance {
  media: DetectedMedia;
  videoElement: HTMLVideoElement | null;
  buttonEl: HTMLElement;
  dropdownEl: HTMLElement | null;
  repositionHandler: (() => void) | null;
}

export class VideoOverlayManager {
  private overlays = new Map<string, OverlayInstance>();
  private onDownload: OnDownloadRequest;

  constructor(onDownload: OnDownloadRequest) {
    this.onDownload = onDownload;
    injectStyles();
  }

  /**
   * Show an overlay for a detected media.
   * If a video element is found, positions the button over it.
   * If variants are available, shows a quality picker dropdown.
   */
  addOverlay(media: DetectedMedia, variants?: MediaVariant[]): void {
    // Skip if already shown
    if (this.overlays.has(media.id)) {
      // Update variants if they arrived later
      const existing = this.overlays.get(media.id)!;
      if (variants && variants.length > 0) {
        existing.media = { ...media, variants };
      }
      return;
    }

    // Find the video element on the page
    const videoEl = this.findVideoElement(media);
    if (!videoEl) return; // No video element to attach to

    // Ensure the video's parent is positioned
    const parent = videoEl.parentElement;
    if (parent) {
      const pos = getComputedStyle(parent).position;
      if (pos === 'static') {
        parent.style.position = 'relative';
      }
    }

    // Create the button
    const btn = this.createButton(media, variants);
    const overlay: OverlayInstance = {
      media: variants ? { ...media, variants } : media,
      videoElement: videoEl,
      buttonEl: btn,
      dropdownEl: null,
      repositionHandler: null,
    };

    // Position the button
    this.positionButton(btn, videoEl);

    // Insert into DOM (relative to video's parent)
    (parent || document.body).appendChild(btn);

    // Show with animation
    requestAnimationFrame(() => {
      btn.classList.add(`${PREFIX}-visible`);
    });

    // Reposition on scroll/resize
    const reposition = () => this.positionButton(btn, videoEl);
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    overlay.repositionHandler = reposition;

    this.overlays.set(media.id, overlay);

    // Mark the video element so we don't double-process
    videoEl.setAttribute(OVERLAY_ATTR, media.id);
  }

  /** Remove all overlays and clean up */
  destroy(): void {
    for (const [, overlay] of this.overlays) {
      this.removeOverlayInstance(overlay);
    }
    this.overlays.clear();
  }

  /** Remove a specific overlay */
  removeOverlay(id: string): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      this.removeOverlayInstance(overlay);
      this.overlays.delete(id);
    }
  }

  // ==========================================================================
  // Private: Button Creation
  // ==========================================================================

  private createButton(media: DetectedMedia, variants?: MediaVariant[]): HTMLElement {
    const btn = document.createElement('div');
    btn.className = `${PREFIX}-btn`;

    const hasMultipleQualities = variants && variants.length > 1;

    btn.innerHTML = `
      ${downloadIconSVG()}
      <span>DLMan</span>
      ${hasMultipleQualities ? chevronDownSVG() : ''}
    `;

    if (hasMultipleQualities) {
      // Click toggles quality dropdown
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleDropdown(media.id, btn, variants!);
      });
    } else {
      // Single quality — download immediately
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.requestDownload(media, 0);
      });
    }

    return btn;
  }

  // ==========================================================================
  // Private: Quality Dropdown
  // ==========================================================================

  private toggleDropdown(
    mediaId: string,
    anchorBtn: HTMLElement,
    variants: MediaVariant[],
  ): void {
    const overlay = this.overlays.get(mediaId);
    if (!overlay) return;

    // If dropdown exists and open, close it
    if (overlay.dropdownEl) {
      this.closeDropdown(overlay);
      return;
    }

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = `${PREFIX}-dropdown`;

    const title = document.createElement('div');
    title.className = `${PREFIX}-dropdown-title`;
    title.textContent = 'Select Quality';
    dropdown.appendChild(title);

    variants.forEach((variant, index) => {
      const item = document.createElement('div');
      item.className = `${PREFIX}-dropdown-item`;

      const label = document.createElement('span');
      label.className = `${PREFIX}-dropdown-item-label`;
      label.textContent = variant.label;

      const meta = document.createElement('span');
      meta.className = `${PREFIX}-dropdown-item-meta`;
      const metaParts: string[] = [];
      if (variant.codecs) metaParts.push(variant.codecs.split(',')[0]);
      if (variant.estimated_size) metaParts.push(formatSize(variant.estimated_size));
      if (variant.bandwidth) metaParts.push(formatBitrate(variant.bandwidth));
      meta.textContent = metaParts.join(' · ');

      item.appendChild(label);
      if (metaParts.length > 0) item.appendChild(meta);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.requestDownload(overlay.media, index);
        this.closeDropdown(overlay);
      });

      dropdown.appendChild(item);
    });

    // "Best Quality" option at top
    if (variants.length > 1) {
      const divider = document.createElement('div');
      divider.className = `${PREFIX}-dropdown-divider`;

      const bestItem = document.createElement('div');
      bestItem.className = `${PREFIX}-dropdown-item`;
      bestItem.innerHTML = `<span class="${PREFIX}-dropdown-item-label">⚡ Best Quality</span>`;
      bestItem.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.requestDownload(overlay.media, undefined);
        this.closeDropdown(overlay);
      });

      // Insert at beginning after title
      dropdown.insertBefore(divider, title.nextSibling);
      dropdown.insertBefore(bestItem, divider.nextSibling);
    }

    anchorBtn.appendChild(dropdown);
    overlay.dropdownEl = dropdown;

    // Open with animation
    requestAnimationFrame(() => {
      dropdown.classList.add(`${PREFIX}-open`);
    });

    // Close on outside click
    const closeHandler = (e: MouseEvent) => {
      if (!anchorBtn.contains(e.target as Node)) {
        this.closeDropdown(overlay);
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', closeHandler, true);
    }, 0);
  }

  private closeDropdown(overlay: OverlayInstance): void {
    if (!overlay.dropdownEl) return;
    overlay.dropdownEl.classList.remove(`${PREFIX}-open`);
    setTimeout(() => {
      overlay.dropdownEl?.remove();
      overlay.dropdownEl = null;
    }, 200);
  }

  // ==========================================================================
  // Private: Download Request
  // ==========================================================================

  private requestDownload(media: DetectedMedia, variantIndex?: number): void {
    const request: MediaDownloadRequest = {
      media,
      variant_index: variantIndex,
    };
    this.onDownload(request);
  }

  // ==========================================================================
  // Private: Positioning
  // ==========================================================================

  private positionButton(btn: HTMLElement, video: HTMLVideoElement): void {
    const parent = video.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    const videoRect = video.getBoundingClientRect();

    // Position top-right of the video, inside the parent
    const top = videoRect.top - parentRect.top + 12;
    const right = parentRect.right - videoRect.right + 12;

    btn.style.top = `${top}px`;
    btn.style.right = `${right}px`;
    btn.style.position = 'absolute';
  }

  // ==========================================================================
  // Private: Find Video Element
  // ==========================================================================

  private findVideoElement(media: DetectedMedia): HTMLVideoElement | null {
    // First, try to find a video element with a matching src
    const videos = document.querySelectorAll('video');
    for (const video of videos) {
      const v = video as HTMLVideoElement;

      // Skip if already has an overlay
      if (v.getAttribute(OVERLAY_ATTR)) continue;

      const src = v.currentSrc || v.src;
      if (src && this.urlsMatch(src, media.master_url)) {
        return v;
      }

      // Check <source> children
      for (const source of v.querySelectorAll('source')) {
        const sourceSrc = (source as HTMLSourceElement).src;
        if (sourceSrc && this.urlsMatch(sourceSrc, media.master_url)) {
          return v;
        }
      }
    }

    // Fallback: find the largest visible video without an overlay
    let bestVideo: HTMLVideoElement | null = null;
    let bestArea = 0;

    for (const video of videos) {
      const v = video as HTMLVideoElement;
      if (v.getAttribute(OVERLAY_ATTR)) continue;

      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && rect.width > 100 && rect.height > 60) {
        bestArea = area;
        bestVideo = v;
      }
    }

    return bestVideo;
  }

  /** Check if two URLs refer to the same resource (ignoring query params) */
  private urlsMatch(a: string, b: string): boolean {
    try {
      const urlA = new URL(a);
      const urlB = new URL(b);
      return urlA.origin === urlB.origin && urlA.pathname === urlB.pathname;
    } catch {
      return a === b;
    }
  }

  // ==========================================================================
  // Private: Cleanup
  // ==========================================================================

  private removeOverlayInstance(overlay: OverlayInstance): void {
    overlay.buttonEl.remove();
    overlay.dropdownEl?.remove();
    if (overlay.repositionHandler) {
      window.removeEventListener('scroll', overlay.repositionHandler);
      window.removeEventListener('resize', overlay.repositionHandler);
    }
    if (overlay.videoElement) {
      overlay.videoElement.removeAttribute(OVERLAY_ATTR);
    }
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatBitrate(bps: number): string {
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1000000) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1000000).toFixed(1)} Mbps`;
}
