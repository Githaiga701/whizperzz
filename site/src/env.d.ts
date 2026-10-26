declare namespace App {
  interface Locals {
    /** Username of the logged-in admin, set by src/middleware.ts. */
    admin?: string;
    /** The visitor's IP address (see src/lib/server/client-ip.ts), set by src/middleware.ts. */
    ip: string;
  }
}
