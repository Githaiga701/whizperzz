// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attemptId, backoff, isOnline, onConnectivity, reportConnectivity, request } from '@/lib/client/network';
import { attachValidation, messageFor } from '@/lib/client/validate';
import { editDistance, suggestSpelling } from '@/lib/client/search';
import { applyDraft, clearDraft, collect, DRAFT_TTL_MS, readDraft, saveDraft } from '@/lib/client/drafts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  reportConnectivity(true);
  sessionStorage.clear();
});

/* ---------- request() ---------- */

describe('request', () => {
  it('returns the reply, even an error status, and marks us online', async () => {
    reportConnectivity(false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"nope"}', { status: 400 })));
    const out = await request('/x');
    expect(out.kind).toBe('reply');
    expect(out.kind === 'reply' && out.res.status).toBe(400);
    expect(isOnline()).toBe(true);
  });

  it('calls a failed connection "offline" and tells listeners', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const seen: boolean[] = [];
    const stop = onConnectivity((up) => seen.push(up));
    expect((await request('/x')).kind).toBe('offline');
    expect(isOnline()).toBe(false);
    expect(seen).toEqual([false]);
    stop();
  });

  it('gives up after the timeout without calling it offline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
    );
    const onSlow = vi.fn();
    const pending = request('/x', {}, { timeoutMs: 20_000, slowMs: 5_000, onSlow });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).kind).toBe('timeout');
    expect(isOnline()).toBe(true);
  });

  it('does not call "slow" when the reply is quick', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const onSlow = vi.fn();
    await request('/x', {}, { slowMs: 100, onSlow });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('reports a cancel by the caller as cancelled', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))),
    );
    const pending = request('/x', {}, { signal: ctrl.signal });
    ctrl.abort();
    expect((await pending).kind).toBe('cancelled');
  });
});

describe('backoff and attempt ids', () => {
  it('doubles up to a cap', () => {
    const fixed = () => 0.5; // no jitter
    expect([0, 1, 2, 3, 10].map((n) => backoff(n, 2_000, 30_000, fixed))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  it('makes a fresh id each time, in the shape the server accepts', () => {
    const a = attemptId();
    expect(a).toMatch(/^[\w-]{8,64}$/);
    expect(attemptId()).not.toBe(a);
  });
});

/* ---------- Validation ---------- */

function form(html: string): HTMLFormElement {
  document.body.innerHTML = `<form id="f">${html}<button type="submit">Send</button></form>`;
  return document.querySelector('form')!;
}

describe('messageFor', () => {
  it('uses the field’s own message, then sensible defaults', () => {
    const f = form(`
      <input name="a" required data-error-required="Enter your name." />
      <input name="b" type="email" required />
      <input name="c" type="number" min="1" max="40" data-error-max="For groups over 40, tell us in the message." />`);
    const [a, b, c] = [...f.querySelectorAll('input')];
    expect(messageFor(a!)).toBe('Enter your name.');
    expect(messageFor(b!)).toBe('Enter your email address.');
    b!.value = 'jane@';
    expect(messageFor(b!)).toBe('Enter an email address like name@example.com.');
    c!.value = '0';
    expect(messageFor(c!)).toBe('Enter 1 or more.');
    c!.value = '50';
    expect(messageFor(c!)).toBe('For groups over 40, tell us in the message.');
    // (Date ranges, "Choose 10 November 2026 or later.", are checked in a real browser: tests/e2e/states.spec.ts.)
  });

  it('runs custom checks only on filled-in fields', () => {
    const f = form('<input name="phone" required />');
    const el = f.querySelector('input')!;
    const checks = { phone: (v: string) => (v.startsWith('07') ? '' : 'Enter a Safaricom number.') };
    expect(messageFor(el, checks)).toBe('Fill this in.');
    el.value = '123';
    expect(messageFor(el, checks)).toBe('Enter a Safaricom number.');
    el.value = '0712345678';
    expect(messageFor(el, checks)).toBe('');
  });
});

describe('attachValidation', () => {
  it('blocks a bad submit, wires the error to the field, and focuses it', () => {
    const f = form('<label>Name <input name="name" required /></label>');
    const own = vi.fn((e: Event) => e.preventDefault());
    attachValidation(f);
    f.addEventListener('submit', own);
    const e = new Event('submit', { cancelable: true });
    f.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(own).not.toHaveBeenCalled();
    const input = f.querySelector('input')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const err = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(err.textContent).toBe('Fill this in.');
    expect(err.hidden).toBe(false);
    // Kept out of the field's accessible name, read as its description.
    expect(err.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(input);
  });

  it('shows a summary with links when several fields need fixing', () => {
    const f = form('<label>A <input name="a" required /></label><label>B <input name="b" required /></label>');
    attachValidation(f);
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    const summary = f.querySelector<HTMLElement>('[data-error-summary]')!;
    expect(summary.hidden).toBe(false);
    expect(summary.getAttribute('role')).toBe('alert');
    expect(summary.textContent).toContain('Please fix 2 things');
    expect([...summary.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['#f-a', '#f-b']);
  });

  it('clears the error as soon as it is fixed, and lets a good form through', () => {
    const f = form('<label>Name <input name="name" required /></label>');
    const own = vi.fn((e: Event) => e.preventDefault());
    attachValidation(f);
    f.addEventListener('submit', own);
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    const input = f.querySelector('input')!;
    input.value = 'Jane';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    f.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while someone types a field for the first time', () => {
    const f = form('<label>Email <input name="email" type="email" /></label>');
    attachValidation(f);
    const input = f.querySelector('input')!;
    input.value = 'jan';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });
});

/* ---------- "Did you mean" ---------- */

describe('suggestSpelling', () => {
  const words = ['elephant', 'beach', 'diani', 'mara', 'flamingo', 'lamu'];

  it('fixes small typos with words that are really on the page', () => {
    expect(suggestSpelling('elephnat', words)).toBe('elephant');
    expect(suggestSpelling('flamigo', words)).toBe('flamingo');
    expect(suggestSpelling('Beech', words)).toBe('beach');
  });

  it('leaves alone words it knows, word starts, and anything too far off', () => {
    expect(suggestSpelling('beach', words)).toBeNull();
    expect(suggestSpelling('flam', words)).toBeNull();
    expect(suggestSpelling('penguins', words)).toBeNull();
  });

  it('counts a swapped pair of letters as one change', () => {
    expect(editDistance('mraa', 'mara')).toBe(1);
  });
});

/* ---------- Drafts kept through an expired login ---------- */

describe('drafts', () => {
  function adminForms() {
    document.body.innerHTML = `
      <form method="post"><input name="guestName" /><input name="amountKes" /><input name="password" type="password" />
        <input name="consumerSecret" /><input name="action" type="hidden" value="save" /><input type="checkbox" name="sendEmail" value="on" />
        <select name="status"><option>a</option><option>b</option></select></form>
      <form method="post" data-no-draft><input name="username" /></form>`;
    return [...document.querySelectorAll('form')];
  }

  it('keeps ordinary fields but never passwords, secrets or hidden fields', () => {
    const [f] = adminForms();
    (f!.elements.namedItem('guestName') as HTMLInputElement).value = 'Jane';
    (f!.elements.namedItem('password') as HTMLInputElement).value = 'hunter2';
    (f!.elements.namedItem('consumerSecret') as HTMLInputElement).value = 'sk_live';
    const fields = collect(f!);
    expect(fields['guestName']).toBe('Jane');
    expect(Object.keys(fields)).not.toContain('password');
    expect(Object.keys(fields)).not.toContain('consumerSecret');
    expect(Object.keys(fields)).not.toContain('action');
  });

  it('puts the typing back on the same page, and skips forms marked data-no-draft', () => {
    let forms = adminForms();
    (forms[0]!.elements.namedItem('guestName') as HTMLInputElement).value = 'Jane';
    (forms[0]!.elements.namedItem('sendEmail') as HTMLInputElement).checked = true;
    (forms[0]!.elements.namedItem('status') as HTMLSelectElement).value = 'b';
    (forms[1]!.elements.namedItem('username') as HTMLInputElement).value = 'admin';
    saveDraft('/admin/quotes/new/', forms);

    forms = adminForms(); // the page loads again, empty
    const draft = readDraft('/admin/quotes/new/');
    expect(draft).not.toBeNull();
    expect(applyDraft(draft!, forms)).toBe(3);
    expect((forms[0]!.elements.namedItem('guestName') as HTMLInputElement).value).toBe('Jane');
    expect((forms[0]!.elements.namedItem('sendEmail') as HTMLInputElement).checked).toBe(true);
    expect((forms[0]!.elements.namedItem('status') as HTMLSelectElement).value).toBe('b');
    expect((forms[1]!.elements.namedItem('username') as HTMLInputElement).value).toBe('');
  });

  it('forgets drafts that are too old, or cleared', () => {
    const forms = adminForms();
    (forms[0]!.elements.namedItem('guestName') as HTMLInputElement).value = 'Jane';
    saveDraft('/p', forms, 1_000);
    expect(readDraft('/p', 1_000 + DRAFT_TTL_MS + 1)).toBeNull();
    saveDraft('/p', forms);
    clearDraft('/p');
    expect(readDraft('/p')).toBeNull();
  });
});

beforeEach(() => {
  document.body.innerHTML = '';
});
