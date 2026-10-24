import type { APIRoute } from 'astro';
import { endSession, setFlash } from '@/lib/admin/web';

export const prerender = false;

export const POST: APIRoute = ({ cookies, redirect }) => {
  endSession(cookies);
  setFlash(cookies, 'ok', 'You’ve logged out.');
  return redirect('/admin/login/');
};
