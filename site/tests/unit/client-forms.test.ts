// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { readJson, trackSubmitter } from '@/lib/client/forms';
import { openWhatsApp } from '@/lib/enquiry';

function makeForm() {
  document.body.innerHTML = `
    <form>
      <input name="name" />
      <button type="submit" value="whatsapp">WhatsApp</button>
      <button type="submit" value="email" data-confirm="Sure?">Email</button>
      <button type="button" data-step="1">+</button>
    </form>`;
  const form = document.querySelector('form')!;
  const [wa, email, plain] = [...form.querySelectorAll('button')];
  return { form, wa: wa!, email: email!, plain: plain!, input: form.querySelector('input')! };
}

/** A submit event as older Safari sends it: no `submitter`. */
function oldSafariSubmit(form: HTMLFormElement): SubmitEvent {
  const e = new Event('submit', { cancelable: true }) as SubmitEvent;
  form.dispatchEvent(e);
  return e;
}

describe('trackSubmitter', () => {
  it('knows the clicked button even when the browser does not say', () => {
    const { form, email } = makeForm();
    const submitterOf = trackSubmitter(form);
    email.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(submitterOf(oldSafariSubmit(form))?.value).toBe('email');
  });

  it('uses the first submit button when Enter is pressed in a field, as browsers do', () => {
    const { form, email, input } = makeForm();
    const submitterOf = trackSubmitter(form);
    email.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(submitterOf(oldSafariSubmit(form))?.value).toBe('whatsapp');
  });

  it('ignores ordinary (non-submit) buttons and forgets a click once used', () => {
    const { form, email, plain } = makeForm();
    const submitterOf = trackSubmitter(form);
    email.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(submitterOf(oldSafariSubmit(form))?.value).toBe('email');
    plain.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(submitterOf(oldSafariSubmit(form))?.value).toBe('whatsapp');
  });

  it('prefers the browser’s own answer when it has one', () => {
    const { form, wa, email } = makeForm();
    const submitterOf = trackSubmitter(form);
    email.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const e = oldSafariSubmit(form);
    Object.defineProperty(e, 'submitter', { value: wa });
    expect(submitterOf(e)?.value).toBe('whatsapp');
  });
});

describe('readJson', () => {
  it('turns an error page into a readable message instead of a parse error', async () => {
    const data = await readJson(new Response('<html>504 Gateway Timeout</html>', { status: 504 }));
    expect(data.message).toMatch(/trouble/);
  });

  it('passes JSON through', async () => {
    const data = await readJson<{ next: string }>(new Response(JSON.stringify({ next: '/pay/WZ-1/' })));
    expect(data.next).toBe('/pay/WZ-1/');
  });
});

describe('openWhatsApp', () => {
  const url = 'https://wa.me/254700000000?text=hi';

  it('goes straight to WhatsApp in the same tab on a phone', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const open = vi.spyOn(window, 'open');
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ set href(v: string) { assign(v); } } as Location);
    openWhatsApp(url);
    expect(open).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('on a computer, falls back to the same tab when the new tab is blocked', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ set href(v: string) { assign(v); } } as Location);
    openWhatsApp(url);
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('on a computer, opens a new tab and leaves this page alone when allowed', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
    const tab = { opener: window } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ set href(v: string) { assign(v); } } as Location);
    openWhatsApp(url);
    expect(tab.opener).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});
