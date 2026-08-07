// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export class MockIntersectionObserver implements IntersectionObserver {
  static readonly instances: MockIntersectionObserver[] = [];

  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds: readonly number[];
  private readonly targets = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    const threshold = options.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  get observedCount(): number {
    return this.targets.size;
  }

  emit(target: Element, intersectionRatio: number): void {
    if (!this.targets.has(target)) return;
    const rect = target.getBoundingClientRect();
    this.callback([{
      boundingClientRect: rect,
      intersectionRatio,
      intersectionRect: rect,
      isIntersecting: intersectionRatio > 0,
      rootBounds: null,
      target,
      time: performance.now(),
    }], this);
  }

  static latest(): MockIntersectionObserver {
    const observer = this.instances.at(-1);
    if (!observer) throw new Error('No MockIntersectionObserver was constructed');
    return observer;
  }

  static reset(): void {
    this.instances.length = 0;
  }
}

export class MockMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media = '(prefers-reduced-motion: reduce)';
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;

  constructor(public matches: boolean) {
    super();
  }

  addListener(callback: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (callback) this.addEventListener('change', callback as EventListener);
  }

  removeListener(callback: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null): void {
    if (callback) this.removeEventListener('change', callback as EventListener);
  }

  setMatches(matches: boolean): void {
    if (matches === this.matches) return;
    this.matches = matches;
    const event = new Event('change') as MediaQueryListEvent;
    Object.defineProperties(event, {
      matches: { value: matches },
      media: { value: this.media },
    });
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
  }
}

export interface EmbedBrowserMocks {
  media: MockMediaQueryList;
  restore(): void;
}

export function installEmbedBrowserMocks(reducedMotion = false): EmbedBrowserMocks {
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  const originalMatchMedia = window.matchMedia;
  const media = new MockMediaQueryList(reducedMotion);
  MockIntersectionObserver.reset();
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true,
    value: MockIntersectionObserver,
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => media,
  });
  return {
    media,
    restore() {
      MockIntersectionObserver.reset();
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: originalIntersectionObserver,
      });
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
