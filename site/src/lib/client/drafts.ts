/**
 * Keeps what an admin typed into a page's forms, so it can be put back if their login ran out while they were
 * typing. Stored in sessionStorage: only this browser tab, gone when the tab closes, dropped after 30 minutes.
 *
 * Never stored: passwords, files, hidden fields, anything that looks like a key, secret, token or PIN, and forms
 * marked `data-no-draft`.
 */

export const DRAFT_TTL_MS = 30 * 60_000;
const PREFIX = 'wz-draft:';
const SENSITIVE = /pass|secret|key|token|pin\b|otp|card|cvv/i;

type Fields = Record<string, string | string[]>;
export interface Draft {
  at: number;
  forms: { index: number; action: string; fields: Fields }[];
}

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // Blocked storage (some private modes): drafts simply aren't kept.
  }
}

export function keepable(el: Element): el is Field {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return false;
  if (!el.name || el.disabled || SENSITIVE.test(el.name)) return false;
  if (el instanceof HTMLInputElement && ['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) return false;
  if (el.autocomplete && /password|cc-|one-time-code/.test(el.autocomplete)) return false;
  return true;
}

export function collect(form: HTMLFormElement): Fields {
  const fields: Fields = {};
  for (const el of form.elements) {
    if (!keepable(el)) continue;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const list = (fields[el.name] as string[] | undefined) ?? [];
      if (el.checked) list.push(el.value);
      fields[el.name] = list;
    } else if (el instanceof HTMLSelectElement && el.multiple) {
      fields[el.name] = [...el.selectedOptions].map((o) => o.value);
    } else {
      fields[el.name] = el.value;
    }
  }
  return fields;
}

export function saveDraft(path: string, forms: HTMLFormElement[], now = Date.now()): void {
  const draft: Draft = {
    at: now,
    forms: forms
      .map((f, index) => ({ f, index }))
      .filter(({ f }) => !f.hasAttribute('data-no-draft'))
      .map(({ f, index }) => ({ index, action: f.getAttribute('action') ?? '', fields: collect(f) }))
      .filter((d) => Object.keys(d.fields).length > 0),
  };
  try {
    storage()?.setItem(PREFIX + path, JSON.stringify(draft));
  } catch {
    /* full or blocked: not worth bothering the user about */
  }
}

export function readDraft(path: string, now = Date.now()): Draft | null {
  try {
    const raw = storage()?.getItem(PREFIX + path);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    return typeof d.at === 'number' && now - d.at <= DRAFT_TTL_MS && Array.isArray(d.forms) ? d : null;
  } catch {
    return null;
  }
}

export function clearDraft(path: string): void {
  try {
    storage()?.removeItem(PREFIX + path);
  } catch {
    /* ignore */
  }
}

/** Fills the forms back in. Returns how many fields changed. Only forms that still match (same place, same action). */
export function applyDraft(draft: Draft, forms: HTMLFormElement[]): number {
  let changed = 0;
  for (const saved of draft.forms) {
    const form = forms[saved.index];
    if (!form || (form.getAttribute('action') ?? '') !== saved.action || form.hasAttribute('data-no-draft')) continue;
    for (const el of form.elements) {
      if (!keepable(el) || !(el.name in saved.fields)) continue;
      const value = saved.fields[el.name]!;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = Array.isArray(value) && value.includes(el.value);
        if (el.checked !== want) {
          el.checked = want;
          changed++;
        }
      } else if (el instanceof HTMLSelectElement && el.multiple && Array.isArray(value)) {
        [...el.options].forEach((o) => (o.selected = value.includes(o.value)));
        changed++;
      } else if (typeof value === 'string' && el.value !== value) {
        el.value = value;
        changed++;
      }
    }
  }
  return changed;
}
