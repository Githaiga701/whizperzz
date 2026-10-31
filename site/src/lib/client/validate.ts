/**
 * Inline form validation that says what's wrong, where, and how to fix it.
 *
 * - A message under each field, tied to it with aria-describedby, and aria-invalid on the field.
 * - Errors are words plus an icon, never colour alone.
 * - Quiet while the guest is typing a field for the first time; checked when they leave it or press submit,
 *   then re-checked live as they fix it.
 * - Two or more problems on submit: a summary at the top with links to each field. One problem: focus it.
 * - The server always checks again. This is for speed and clarity, not security.
 *
 * Messages come from `data-error-<kind>` on the field (required, type, min, max, pattern, length) or sensible
 * defaults, and custom checks can be added per field name.
 */

export type Check = (value: string, el: Control) => string;
export type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface Validation {
  /** Checks every field and shows the errors. True when the form is fine. */
  validate(): boolean;
  /** Clears every message (e.g. after the form is reset). */
  reset(): void;
}

const SKIP = new Set(['hidden', 'submit', 'button', 'reset', 'image']);
let uid = 0;

function controls(form: HTMLFormElement): Control[] {
  return [...form.elements].filter(
    (el): el is Control =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) &&
      !SKIP.has((el as HTMLInputElement).type) &&
      Boolean(el.name),
  );
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The message for a field's current value, or '' when it's fine. */
export function messageFor(el: Control, checks: Record<string, Check> = {}): string {
  const custom = checks[el.name];
  const value = el.value.trim();
  // Custom checks run only on a filled-in field, so "required" keeps its own message.
  el.setCustomValidity(custom && value ? custom(value, el) : '');
  const v = el.validity;
  if (v.valid) return '';
  const d = el.dataset;
  const type = el instanceof HTMLInputElement ? el.type : el instanceof HTMLSelectElement ? 'select' : 'text';
  if (v.valueMissing) {
    if (d['errorRequired']) return d['errorRequired'];
    if (type === 'select') return 'Choose an option.';
    if (type === 'date') return 'Choose a date.';
    if (type === 'email') return 'Enter your email address.';
    if (type === 'tel') return 'Enter your phone number.';
    if (type === 'password') return 'Enter your password.';
    return 'Fill this in.';
  }
  if (v.customError) return el.validationMessage;
  if (v.typeMismatch || v.badInput) {
    if (d['errorType']) return d['errorType'];
    if (type === 'email') return 'Enter an email address like name@example.com.';
    if (type === 'number') return 'Enter a number.';
    if (type === 'date') return 'Enter a real date.';
    return 'Check the format.';
  }
  const input = el as HTMLInputElement;
  if (v.rangeUnderflow) return d['errorMin'] ?? (type === 'date' ? `Choose ${prettyDate(input.min)} or later.` : `Enter ${input.min} or more.`);
  if (v.rangeOverflow) return d['errorMax'] ?? (type === 'date' ? `Choose ${prettyDate(input.max)} or earlier.` : `Enter ${input.max} or fewer.`);
  if (v.tooLong) return d['errorLength'] ?? `Use ${input.maxLength} characters or fewer.`;
  if (v.tooShort) return d['errorLength'] ?? `Use at least ${input.minLength} characters.`;
  if (v.patternMismatch) return d['errorPattern'] ?? 'Check the format.';
  if (v.stepMismatch) return 'Enter a whole number.';
  return el.validationMessage || 'Check this.';
}

export function attachValidation(form: HTMLFormElement, checks: Record<string, Check> = {}): Validation {
  form.noValidate = true;
  const formId = form.id || `form-${++uid}`;
  const errors = new Map<Control, HTMLElement>();
  const touched = new Set<Control>();

  const errorEl = (el: Control): HTMLElement => {
    let e = errors.get(el);
    if (e) return e;
    if (!el.id) el.id = `${formId}-${el.name}`;
    e = document.createElement('span');
    e.className = 'field-error';
    e.id = `${el.id}-error`;
    e.hidden = true;
    // Inside the <label> it would become part of the field's name; aria-hidden keeps it out of the name,
    // and aria-describedby still reads it out as the description.
    e.setAttribute('aria-hidden', 'true');
    const label = el.closest('label');
    const anchor = label && form.contains(label) ? label : el.parentElement;
    anchor?.append(e);
    const described = (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
    if (!described.includes(e.id)) el.setAttribute('aria-describedby', [...described, e.id].join(' '));
    errors.set(el, e);
    return e;
  };

  const show = (el: Control, message: string) => {
    if (!message && !errors.has(el)) return;
    const e = errorEl(el);
    e.textContent = message;
    e.hidden = !message;
    if (message) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  };

  const check = (el: Control, display: boolean): string => {
    const message = messageFor(el, checks);
    if (display) show(el, message);
    return message;
  };

  let summary: HTMLElement | null = form.querySelector('[data-error-summary]');
  const hideSummary = () => {
    if (summary) {
      summary.hidden = true;
      summary.replaceChildren();
    }
  };

  form.addEventListener('focusout', (e) => {
    const el = e.target as Control;
    // Leaving the field to press a button: let the submit check it. Showing the error now would push the button
    // down between press and release, and the press would miss.
    const next = (e as FocusEvent).relatedTarget;
    if (next instanceof HTMLButtonElement && next.form === form) return;
    if (touched.has(el)) check(el, true);
  });
  form.addEventListener('input', (e) => {
    const el = e.target as Control;
    if (!controls(form).includes(el)) return;
    touched.add(el);
    // Already showing an error: update it as they type, so it disappears the moment it's fixed.
    if (el.getAttribute('aria-invalid') === 'true') check(el, true);
  });
  form.addEventListener('change', (e) => {
    const el = e.target as Control;
    touched.add(el);
    if (el.getAttribute('aria-invalid') === 'true' || el instanceof HTMLSelectElement) check(el, true);
  });

  function validate(): boolean {
    hideSummary();
    const bad: { el: Control; message: string }[] = [];
    for (const el of controls(form)) {
      if (el.disabled || el.closest('[hidden]')) continue;
      touched.add(el);
      const message = check(el, true);
      if (message) bad.push({ el, message });
    }
    if (bad.length === 0) return true;
    if (bad.length === 1) {
      bad[0]!.el.focus();
      return false;
    }
    if (!summary) {
      summary = document.createElement('div');
      summary.setAttribute('data-error-summary', '');
      form.prepend(summary);
    }
    summary.className = 'error-summary';
    summary.setAttribute('role', 'alert');
    summary.tabIndex = -1;
    const title = document.createElement('p');
    title.textContent = `Please fix ${bad.length} things before you continue:`;
    const list = document.createElement('ul');
    for (const { el, message } of bad) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `#${el.id}`;
      a.textContent = message;
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        el.focus();
      });
      li.append(a);
      list.append(li);
    }
    summary.replaceChildren(title, list);
    summary.hidden = false;
    summary.focus();
    return false;
  }

  // Runs before the form's own submit handler (it's added first), and stops it when something's wrong.
  form.addEventListener('submit', (e) => {
    if (validate()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  });

  return {
    validate,
    reset() {
      hideSummary();
      touched.clear();
      errors.forEach((e, el) => {
        e.hidden = true;
        e.textContent = '';
        el.removeAttribute('aria-invalid');
      });
    },
  };
}
