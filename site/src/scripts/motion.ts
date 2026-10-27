/**
 * Gentle movement for the public site. Everything here is decoration: the page reads the same without it.
 * <html class="motion">: full movement. <html class="motion-soft">: the device asked for reduced motion, so
 * sections only fade in (no sliding, zooming, parallax or leaning).
 */

const root = document.documentElement;
const moving = root.classList.contains('motion');
const fading = moving || root.classList.contains('motion-soft');
/** A mouse or trackpad; phones and tablets have neither, so they get scroll and tap movement instead of hover. */
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ---------- Scroll reveals: [data-reveal], staggered inside [data-reveal-group] ---------- */

function reveals() {
  const items = [...document.querySelectorAll<HTMLElement>('[data-reveal], [data-reveal-group] > *, .kenya-map[data-animate], [data-words]')];
  document.querySelectorAll<HTMLElement>('[data-reveal-group]').forEach((group) => {
    [...group.children].forEach((child, i) => (child as HTMLElement).style.setProperty('--i', String(i % 6)));
  });
  if (!fading || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add('is-in');
        if (moving && el.matches('.kenya-map[data-animate]')) drawRoute(el);
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
  if (!moving || !finePointer) return;
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

/* ---------- Touch screens: cards lean as they pass through the screen ---------- */

function lean() {
  if (!moving || finePointer || !('IntersectionObserver' in window)) return;
  const cards = [...document.querySelectorAll<HTMLElement>('[data-tilt]')];
  if (!cards.length) return;
  const onScreen = new Set<HTMLElement>();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const card = e.target as HTMLElement;
      if (e.isIntersecting) onScreen.add(card);
      else onScreen.delete(card);
    }
    schedule();
  });
  cards.forEach((c) => io.observe(c));
  let ticking = false;
  const update = () => {
    ticking = false;
    const vh = window.innerHeight || 1;
    for (const card of onScreen) {
      // Leaning starts once the card has finished rising into place.
      if (!card.classList.contains('is-in')) continue;
      if (!card.classList.contains('is-leaning')) {
        if (!card.dataset['leanAt']) card.dataset['leanAt'] = String(performance.now());
        if (performance.now() - Number(card.dataset['leanAt']) < 1000) {
          schedule();
          continue;
        }
        card.classList.add('is-leaning');
      }
      const r = card.getBoundingClientRect();
      // -0.5 when the card's middle is at the top of the screen, 0 in the middle, 0.5 at the bottom.
      const t = Math.max(-0.5, Math.min(0.5, (r.top + r.height / 2) / vh - 0.5));
      card.style.setProperty('--rx', `${(t * 9).toFixed(2)}deg`);
      card.style.setProperty('--gy', `${((0.5 - t) * 100).toFixed(0)}%`);
      card.classList.toggle('is-lit', Math.abs(t) < 0.2);
    }
  };
  function schedule() {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
}

numberPins();
reveals();
parallax();
tilt();
lean();
