import { PackageError, type PackageInput } from '@/lib/packages/store';
import { saveImage } from '@/lib/packages/uploads';
import { uploadsDir } from './packages';

const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};
const all = (form: FormData, name: string) => form.getAll(name).filter((v): v is string => typeof v === 'string');

/**
 * Turns the admin's journey form into input for validatePackage, saving an uploaded photo if there is one.
 * A bad photo doesn't lose what was typed: it comes back as `photoError` alongside the input.
 */
export async function readPackageForm(form: FormData, idHint: string): Promise<{ input: PackageInput; photoError?: string }> {
  const titles = all(form, 'dayTitle');
  const notes = all(form, 'dayNote');
  const spans = all(form, 'daySpan');
  let photoSrc = text(form, 'photoSrc');
  let photoError: string | undefined;
  const file = form.get('photoFile');
  if (file instanceof File && file.size > 0) {
    try {
      photoSrc = saveImage(uploadsDir(), new Uint8Array(await file.arrayBuffer()), idHint);
    } catch (err) {
      if (!(err instanceof PackageError)) throw err;
      photoError = err.message;
    }
  }
  const input: PackageInput = {
    id: text(form, 'id'),
    name: text(form, 'name'),
    route: all(form, 'route'),
    styles: all(form, 'styles'),
    photoSrc,
    photoAlt: text(form, 'photoAlt'),
    summary: text(form, 'summary'),
    whisper: text(form, 'whisper'),
    itinerary: titles.map((title, i) => ({ title, note: notes[i] ?? '', span: spans[i] ?? '1' })),
    order: text(form, 'order'),
    published: text(form, 'published'),
    adultKes: text(form, 'adultKes'),
    childKes: text(form, 'childKes'),
    minGuests: text(form, 'minGuests'),
    maxGuests: text(form, 'maxGuests'),
  };
  return photoError ? { input, photoError } : { input };
}
