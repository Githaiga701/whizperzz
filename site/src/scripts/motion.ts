/**
 * Gentle movement for the public site. Everything here is decoration: the page reads the same without it,
 * and none of it runs for people who ask their device for reduced motion (the <html class="motion"> switch).
 */

const root = document.documentElement;
const moving = root.classList.contains('motion');

/* ---------- Scroll reveals: [data-reveal], staggered inside [data-reveal-group] ---------- */

function reveals() {
  const items = [...document.querySelectorAll<HTMLElement>('[data-reveal], [data-reveal-group] > *, .kenya-map[data-animate], [data-words]')];
  document.querySelectorAll<HTMLElement>('[data-reveal-group]').forEach((group) => {
    [...group.children].forEach((child, i) => (child as HTMLElement).style.setProperty('--i', String(i % 6)));
  });
  if (!moving || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add('is-in');
        if (el.matches('.kenya-map[data-animate]')) drawRoute(el);
        io.unobserve(el);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  items.forEach((el) => io.observe(el));
}

/* ---------- Map: pins drop in one by one, then the route draws itself ---------- */

function drawRoute(svg: Element) {
  const mask = svg.querySelector<SVGPathElement>('[data-route-mask]');
  if (!mask || !mask.getAttribute('d')) return;
  const len = Math.ceil(mask.getTotalLength());
  mask.style.setProperty('--len', String(len));
  mask.style.strokeDasharray = String(len);
  mask.style.animationDelay = '0.5s';
  void mask.getBoundingClientRect();
  mask.classList.add('is-drawing');
}

function numberPins() {
  document.querySelectorAll('.kenya-map[data-animate]').forEach((svg) => {
    svg.querySelectorAll<SVGElement>('.pin').forEach((pin, i) => pin.style.setProperty('--i', String(i)));
  });
}

/* ---------- Hero: slow parallax as you scroll away ---------- */

function parallax() {
  const hero = document.querySelector<HTMLElement>('[data-parallax]');
  if (!hero || !moving) return;
  const photo = hero.querySelector<HTMLElement>('.hero-photo');
  const copy = hero.querySelector<HTMLElement>('.wrap');
  let ticking = false;
  const update = () => {
    ticking = false;
    const y = Math.min(window.scrollY, hero.offsetHeight);
    if (photo) photo.style.transform = `translate3d(0, ${y * 0.3}px, 0)`;
    if (copy) {
      copy.style.transform = `translate3d(0, ${y * 0.12}px, 0)`;
      copy.style.opacity = String(Math.max(0, 1 - y / (hero.offsetHeight * 0.9)));
    }
  };
  window.addEventListener(
    'scroll',
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true },
  );
  update();
}

/* ---------- Cards lean towards the pointer ---------- */

function tilt() {
  if (!moving || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.querySelectorAll<HTMLElement>('[data-tilt]').forEach((card) => {
    let frame = 0;
    card.addEventListener('pointerenter', () => (card.style.transitionDelay = '0s'));
    card.addEventListener('pointermove', (e) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.setProperty('--rx', `${(-y * 5).toFixed(2)}deg`);
        card.style.setProperty('--ry', `${(x * 6).toFixed(2)}deg`);
        card.style.setProperty('--gx', `${((x + 0.5) * 100).toFixed(0)}%`);
        card.style.setProperty('--gy', `${((y + 0.5) * 100).toFixed(0)}%`);
        card.classList.add('is-tilting');
      });
    });
    card.addEventListener('pointerleave', () => {
      cancelAnimationFrame(frame);
      card.classList.remove('is-tilting');
      card.style.removeProperty('--rx');
      card.style.removeProperty('--ry');
    });
  });
}

numberPins();
reveals();
parallax();
tilt();
