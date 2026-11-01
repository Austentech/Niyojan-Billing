/** Shared types for the Phase 2 firm-management system. */

/** Database row in public.firms (as returned by PostgREST). */
export interface FirmRecord {
  id: string;
  firm_name: string;
  logo_url: string | null;
  website_url: string | null;
  /** numeric(5,2) — arrives as a JSON number (or string via some drivers). */
  holding_percentage: number | string;
  address: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Presentation view of a firm — the ONLY shape ever handed to client
 * components. Derived exclusively from the database; nothing here is
 * hardcoded in frontend code.
 */
export interface FirmView {
  /** Stable UUID — future firm-scoped modules will key off this id. */
  id: string;
  name: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  holdingPercentage: number;
  address: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}
