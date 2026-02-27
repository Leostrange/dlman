/**
 * Video Overlay — IDM-style download button on detected videos.
 *
 * KEY DESIGN: Uses `position: fixed` appended to `<html>`, NOT inside the
 * player's DOM. This prevents video player controls from intercepting clicks
 * or z-index wars inside the player's stacking context.
 *
 * The button tracks the video element's viewport position on scroll/resize
 * via getBoundingClientRect().
 */

import type { DetectedMedia, MediaVariant, MediaDownloadRequest } from './media-types';

const P = 'dlman-vo';
const OVERLAY_ATTR = 'data-dlman-overlay-id';
const Z = 2147483647; // Max z-index

const dismissed = new Set<string>();
let stylesReady = false;

function ensureStyles(): void {
  if (stylesReady) return;
  stylesReady = true;

  const s = document.createElement('style');
  s.textContent = `
.${P}-wrap{position:fixed;z-index:${Z};display:flex;align-items:center;gap:0;opacity:0;transform:translateY(-6px);transition:opacity .22s ease,transform .22s ease;pointer-events:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.${P}-wrap.${P}-show{opacity:1;transform:translateY(0)}
.${P}-wrap.${P}-hide{display:none}
.${P}-btn{display:flex;align-items:center;gap:5px;padding:6px 10px;background:rgba(0,0,0,.82);color:#fff;font-size:11.5px;font-weight:600;line-height:1;border:1px solid rgba(255,255,255,.15);border-radius:6px 0 0 6px;cursor:pointer;user-select:none;white-space:nowrap;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:background .15s ease;box-shadow:0 2px 12px rgba(0,0,0,.4)}
.${P}-btn:hover{background:rgba(37,99,235,.9)}
.${P}-btn:active{transform:scale(.97)}
.${P}-btn.${P}-solo{border-radius:6px}
.${P}-chevron{display:flex;align-items:center;padding:6px 6px;background:rgba(0,0,0,.82);color:#fff;border:1px solid rgba(255,255,255,.15);border-left:1px solid rgba(255,255,255,.08);border-radius:0 6px 6px 0;cursor:pointer;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:background .15s ease;box-shadow:0 2px 12px rgba(0,0,0,.4)}
.${P}-chevron:hover{background:rgba(37,99,235,.9)}
.${P}-close{display:flex;align-items:center;justify-content:center;width:20px;height:20px;margin-left:4px;background:rgba(0,0,0,.6);color:rgba(255,255,255,.65);border:none;border-radius:50%;cursor:pointer;font-size:12px;line-height:1;transition:background .15s,color .15s;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.${P}-close:hover{background:rgba(239,68,68,.9);color:#fff}
.${P}-ico{width:14px;height:14px;flex-shrink:0}
.${P}-dd{position:absolute;top:calc(100% + 4px);left:0;min-width:180px;background:rgba(15,23,42,.95);border:1px solid rgba(255,255,255,.1);border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.6);padding:4px 0;opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s ease;pointer-events:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.${P}-dd.${P}-open{opacity:1;transform:translateY(0);pointer-events:auto}
.${P}-dd-hdr{padding:6px 10px 4px;font-size:10px;font-weight:700;color:rgba(148,163,184,.8);text-transform:uppercase;letter-spacing:.04em}
.${P}-dd-item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 10px;font-size:12px;color:#e2e8f0;cursor:pointer;transition:background .1s}
.${P}-dd-item:hover{background:rgba(59,130,246,.18)}
.${P}-dd-lbl{font-weight:600}
.${P}-dd-meta{font-size:10px;color:#64748b}
  `;
  document.documentElement.appendChild(s);
}

function icoDownload(): string {
  return `<svg class="${P}-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
}

function icoChevron(): string {
  return `<svg class="${P}-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
}

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

function fmtBitrate(bps: number): string {
  if (bps < 1000) return `${bps} bps`;
  if (bps < 1e6) return `${(bps / 1000).toFixed(0)} kbps`;
  return `${(bps / 1e6).toFixed(1)} Mbps`;
}

// ============================================================================
// VideoOverlayManager
// ============================================================================

export type OnDownloadRequest = (request: MediaDownloadRequest) => void;

interface Overlay {
  media: DetectedMedia;
  video: HTMLVideoElement | null;
  wrap: HTMLElement;
  dropdown: HTMLElement | null;
  rafId: number | null;
}

export class VideoOverlayManager {
  private overlays = new Map<string, Overlay>();
  private onDownload: OnDownloadRequest;
  private scrollHandler: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  constructor(onDownload: OnDownloadRequest) {
    this.onDownload = onDownload;
    ensureStyles();

    // Single scroll/resize listener repositions ALL overlays
    this.scrollHandler = () => this.repositionAll();
    this.resizeHandler = () => this.repositionAll();
    window.addEventListener('scroll', this.scrollHandler, { passive: true, capture: true });
    window.addEventListener('resize', this.resizeHandler, { passive: true });
  }

  addOverlay(media: DetectedMedia, variants?: MediaVariant[]): void {
    if (dismissed.has(media.id)) return;
    if (this.overlays.has(media.id)) {
      const o = this.overlays.get(media.id)!;
      if (variants?.length) o.media = { ...media, variants };
      return;
    }

    const video = this.findVideo(media);
    if (!video) return;

    const hasMulti = variants && variants.length > 1;
    const wrap = document.createElement('div');
    wrap.className = `${P}-wrap`;

    const btn = document.createElement('div');
    btn.className = `${P}-btn` + (hasMulti ? '' : ` ${P}-solo`);
    btn.innerHTML = `${icoDownload()}<span>Download</span>`;

    if (hasMulti) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.doDownload(media, variants, undefined);
      });
      const chev = document.createElement('div');
      chev.className = `${P}-chevron`;
      chev.innerHTML = icoChevron();
      chev.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.toggleDropdown(media.id, wrap, variants!);
      });
      wrap.appendChild(btn);
      wrap.appendChild(chev);
    } else {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.doDownload(media, variants, 0);
      });
      wrap.appendChild(btn);
    }

    const close = document.createElement('div');
    close.className = `${P}-close`;
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissed.add(media.id);
      this.removeOverlay(media.id);
    });
    wrap.appendChild(close);

    const overlay: Overlay = {
      media: variants ? { ...media, variants } : media,
      video,
      wrap,
      dropdown: null,
      rafId: null,
    };

    // Position using fixed coordinates then append to <html> root
    this.positionFixed(wrap, video);
    document.documentElement.appendChild(wrap);

    requestAnimationFrame(() => wrap.classList.add(`${P}-show`));

    this.overlays.set(media.id, overlay);
    video.setAttribute(OVERLAY_ATTR, media.id);
  }

  destroy(): void {
    for (const o of this.overlays.values()) this.cleanup(o);
    this.overlays.clear();
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler, true);
    }
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
  }

  removeOverlay(id: string): void {
    const o = this.overlays.get(id);
    if (o) {
      this.cleanup(o);
      this.overlays.delete(id);
    }
  }

  // ---------- Reposition all overlays ----------

  private repositionAll(): void {
    for (const o of this.overlays.values()) {
      if (!o.video) continue;
      if (o.rafId) cancelAnimationFrame(o.rafId);
      o.rafId = requestAnimationFrame(() => {
        this.positionFixed(o.wrap, o.video!);
        o.rafId = null;
      });
    }
  }

  // ---------- Fixed positioning ----------

  private positionFixed(wrap: HTMLElement, video: HTMLVideoElement): void {
    const vr = video.getBoundingClientRect();

    // Hide if video is not visible (scrolled out of view)
    if (vr.bottom < 0 || vr.top > window.innerHeight || vr.right < 0 || vr.left > window.innerWidth) {
      wrap.classList.add(`${P}-hide`);
      return;
    }
    wrap.classList.remove(`${P}-hide`);

    // Place at top-right of the video, 10px inset
    const top = vr.top + 10;
    const left = vr.right - 10; // We'll use right-align via transform
    wrap.style.top = `${top}px`;
    wrap.style.left = `${left}px`;
    wrap.style.transform = `translateX(-100%)` + (wrap.classList.contains(`${P}-show`) ? '' : ' translateY(-6px)');
  }

  // ---------- Dropdown ----------

  private toggleDropdown(id: string, anchor: HTMLElement, variants: MediaVariant[]): void {
    const o = this.overlays.get(id);
    if (!o) return;
    if (o.dropdown) { this.closeDropdown(o); return; }

    const dd = document.createElement('div');
    dd.className = `${P}-dd`;

    const hdr = document.createElement('div');
    hdr.className = `${P}-dd-hdr`;
    hdr.textContent = 'Quality';
    dd.appendChild(hdr);

    variants.forEach((v, i) => {
      const item = document.createElement('div');
      item.className = `${P}-dd-item`;
      const lbl = document.createElement('span');
      lbl.className = `${P}-dd-lbl`;
      lbl.textContent = v.label;
      const meta = document.createElement('span');
      meta.className = `${P}-dd-meta`;
      const parts: string[] = [];
      if (v.codecs) parts.push(v.codecs.split(',')[0]);
      if (v.estimated_size) parts.push(fmtSize(v.estimated_size));
      if (v.bandwidth) parts.push(fmtBitrate(v.bandwidth));
      meta.textContent = parts.join(' · ');
      item.appendChild(lbl);
      if (parts.length) item.appendChild(meta);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.doDownload(o.media, variants, i);
        this.closeDropdown(o);
      });
      dd.appendChild(item);
    });

    anchor.appendChild(dd);
    o.dropdown = dd;
    requestAnimationFrame(() => dd.classList.add(`${P}-open`));

    const outside = (e: MouseEvent) => {
      if (!anchor.contains(e.target as Node)) {
        this.closeDropdown(o);
        document.removeEventListener('click', outside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', outside, true), 0);
  }

  private closeDropdown(o: Overlay): void {
    if (!o.dropdown) return;
    o.dropdown.classList.remove(`${P}-open`);
    setTimeout(() => { o.dropdown?.remove(); o.dropdown = null; }, 200);
  }

  // ---------- Download ----------

  private doDownload(media: DetectedMedia, variants?: MediaVariant[], idx?: number): void {
    this.onDownload({ media: variants ? { ...media, variants } : media, variant_index: idx });
  }

  // ---------- Find Video ----------

  private findVideo(media: DetectedMedia): HTMLVideoElement | null {
    for (const v of document.querySelectorAll('video')) {
      const el = v as HTMLVideoElement;
      if (el.getAttribute(OVERLAY_ATTR)) continue;
      const src = el.currentSrc || el.src;
      if (src && this.urlMatch(src, media.master_url)) return el;
      for (const s of el.querySelectorAll('source')) {
        if ((s as HTMLSourceElement).src && this.urlMatch((s as HTMLSourceElement).src, media.master_url)) return el;
      }
    }
    let best: HTMLVideoElement | null = null;
    let area = 0;
    for (const v of document.querySelectorAll('video')) {
      const el = v as HTMLVideoElement;
      if (el.getAttribute(OVERLAY_ATTR)) continue;
      const r = el.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area && r.width > 200 && r.height > 120) { area = a; best = el; }
    }
    return best;
  }

  private urlMatch(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.origin === ub.origin && ua.pathname === ub.pathname;
    } catch { return a === b; }
  }

  // ---------- Cleanup ----------

  private cleanup(o: Overlay): void {
    o.wrap.remove();
    o.dropdown?.remove();
    if (o.rafId) cancelAnimationFrame(o.rafId);
    if (o.video) o.video.removeAttribute(OVERLAY_ATTR);
  }
}
