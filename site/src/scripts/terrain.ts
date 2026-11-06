/**
 * Scroll-linked scenery (see styles/terrain.css). Decoration only: without this file the page reads the same,
 * and with reduced motion (html.motion-soft) nothing here moves.
 *
 * - The safari car drives along the road under the header as you read down the page, turns round when you
 *   scroll back up, and kicks up dust while it moves.
 * - The survey-map lines printed on the deeper sheets drift a little slower than the page (--p).
 * - The compass on the home map swings as the map passes.
 */

const root = document.documentElement;
const moving = root.classList.contains('motion');

function scenery() {
  if (!moving) return;

  const car = document.querySelector<HTMLElement>('.road-car');
  const road = car?.parentElement ?? null;
  const sheets = [...document.querySelectorAll<HTMLElement>('.section--deep, .section--dark, .page-hero--plain')];
  const compass = document.querySelector<SVGElement>('.compass');
  const visible = new Set<HTMLElement>();

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target as HTMLElement;
        if (e.isIntersecting) visible.add(el);
        else visible.delete(el);
      }
      schedule();
    });
    sheets.forEach((s) => io.observe(s));
    if (compass) io.observe(compass.closest('section') ?? compass as unknown as HTMLElement);
  }

  let lastY = window.scrollY;
  let dir = 1;
  let stopTimer = 0;
  let ticking = false;

  const update = () => {
    ticking = false;
    const y = window.scrollY;
    const vh = window.innerHeight || 1;

    if (car && road) {
      const max = Math.max(1, document.documentElement.scrollHeight - vh);
      const progress = Math.min(1, Math.max(0, y / max));
      // On narrow screens the logo reaches down to the road, so the car sets off just past it.
      const brand = document.querySelector<HTMLElement>('.site-header .brand-mark');
      const start = brand && window.innerWidth < 700 ? brand.getBoundingClientRect().right + 10 : 8;
      const span = road.clientWidth - car.offsetWidth - 8 - start;
      if (y !== lastY) {
        dir = y > lastY ? 1 : -1;
        car.classList.add('is-driving');
        window.clearTimeout(stopTimer);
        stopTimer = window.setTimeout(() => car.classList.remove('is-driving'), 180);
      }
      car.style.setProperty('--car-x', `${(start + progress * span).toFixed(1)}px`);
      car.style.setProperty('--car-dir', String(dir));
    }

    for (const el of visible) {
      const r = el.getBoundingClientRect();
      if (el.matches('.section--deep, .section--dark, .page-hero--plain')) {
        // -1 when the sheet's top meets the bottom of the screen, 1 when its bottom meets the top
        const p = ((vh - r.top) / (vh + r.height)) * 2 - 1;
        el.style.setProperty('--p', Math.max(-1, Math.min(1, p)).toFixed(3));
      }
      if (compass && el.contains(compass)) {
        const p = (vh - r.top) / (vh + r.height);
        compass.style.setProperty('--compass', `${(-40 + p * 70).toFixed(1)}deg`);
      }
    }
    lastY = y;
  };

  function schedule() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();
}

scenery();

export {};
