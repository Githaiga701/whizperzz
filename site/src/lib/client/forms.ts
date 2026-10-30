/**
 * Small helpers for form buttons in the browser.
 */

/**
 * Which button submitted a form. `SubmitEvent.submitter` is missing on Safari before 15.4 (older iPhones), which made
 * "Email it instead" open WhatsApp and let admin buttons skip their "Are you sure?" question. This remembers the
 * last submit button clicked (or activated with Enter/Space) and falls back to the form's first submit button,
 * which is what the browser uses when Enter is pressed in a field.
 */
export function trackSubmitter(form: HTMLFormElement): (e: SubmitEvent) => HTMLButtonElement | null {
  let last: HTMLButtonElement | null = null;
  const remember = (e: Event) => {
    const btn = (e.target as Element | null)?.closest?.('button');
    if (btn instanceof HTMLButtonElement && btn.form === form && btn.type === 'submit') last = btn;
  };
  form.addEventListener('click', remember, true);
  // Pressing Enter in a field submits with the first button, so forget a button clicked earlier.
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) last = null;
  });
  return (e: SubmitEvent) => {
    const via = (e.submitter as HTMLButtonElement | null | undefined) ?? last ?? form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])');
    last = null;
    return via ?? null;
  };
}

/** Reads a JSON reply, or a plain message if the server sent something else (an error page, a timeout). */
export async function readJson<T extends object>(res: Response): Promise<T & { message?: string }> {
  try {
    return (await res.json()) as T & { message?: string };
  } catch {
    return { message: res.ok ? 'Something went wrong. Please try again.' : 'The server is having trouble right now. Please try again in a minute.' } as T & { message?: string };
  }
}

/** A friendly message for a request that never reached the server ("Failed to fetch", Safari's "Load failed"). */
export const OFFLINE = 'Couldn’t connect. Check your internet connection and try again.';

/**
 * Runs `fn` when the page is shown again from the browser's back/forward cache (e.g. after pressing Back on a
 * payment page), so buttons that were switched off while leaving can be switched back on.
 */
export function onReturn(fn: () => void): void {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) fn();
  });
}
