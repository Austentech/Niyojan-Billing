/**
 * Idempotent first-run bootstrap.
 *
 * Creates the initial administrator account from environment variables and,
 * on a brand-new database, a set of realistic sample firm records so the
 * registry is demonstrable immediately. Running it repeatedly is a no-op.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { hashPassword } from "@/server/auth/password";
import type { Prisma } from "@prisma/client";

let seeding: Promise<void> | null = null;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

const SAMPLE_FIRMS: Prisma.FirmCreateManyInput[] = [
  {
    name: "Shree Balaji Constructions",
    legalName: "Shree Balaji Constructions (Prop. R. Agarwal)",
    gstin: "08AABCU9603R1ZM",
    contactPerson: "Rajendra Agarwal",
    email: "contact@shreebalajiconstructions.in",
    phone: "+91 98290 41236",
    addressLine1: "Plot 14, Malviya Industrial Area",
    city: "Jaipur",
    state: "Rajasthan",
    postalCode: "302017",
    notes: "Turnkey civil contractor — site development and structural packages.",
    status: "ACTIVE",
    createdAt: daysAgo(214),
  },
  {
    name: "Vardhman Steel Supplies",
    legalName: "Vardhman Steel Supplies LLP",
    gstin: "23AAACV2190P1ZK",
    contactPerson: "Meenakshi Vardhman",
    email: "accounts@vardhmansteel.in",
    phone: "+91 91660 72814",
    addressLine1: "Warehouse 7, Sector D, Sanwer Road",
    city: "Indore",
    state: "Madhya Pradesh",
    postalCode: "453551",
    notes: "Long-roll TMT and structural steel stockist. Monthly rate contract.",
    status: "ACTIVE",
    createdAt: daysAgo(182),
  },
  {
    name: "Ashwin Traders & Logistics",
    legalName: "Ashwin Traders & Logistics (P) Ltd.",
    gstin: "24AAGCV4821L1ZS",
    contactPerson: "Nilesh Ashwin",
    email: "ops@ashwintraders.co.in",
    phone: "+91 98795 33410",
    addressLine1: "Bay 22, Fedara Highway Point",
    city: "Ahmedabad",
    state: "Gujarat",
    postalCode: "382110",
    notes: "Bulk material movement and site logistics coordination.",
    status: "ACTIVE",
    createdAt: daysAgo(151),
  },
  {
    name: "Kaveri Interiors",
    legalName: "Kaveri Interiors Studio Pvt. Ltd.",
    gstin: "29AAECS9034M1Z1",
    contactPerson: "Divya Kaveri",
    email: "studio@kaveriinteriors.in",
    phone: "+91 99011 56702",
    addressLine1: "3rd Floor, 100 Ft Road, Indiranagar",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560038",
    notes: "Fit-out and interior execution for corporate offices.",
    status: "ACTIVE",
    createdAt: daysAgo(122),
  },
  {
    name: "Meridian Equipment Rentals",
    legalName: "Meridian Equipment Rentals (P) Ltd.",
    gstin: "27AAHCI1258K1ZT",
    contactPerson: "Sohail Meridian",
    email: "desk@meridianrentals.in",
    phone: "+91 90280 21455",
    addressLine1: "Shed 9, Bhosari MIDC",
    city: "Pune",
    state: "Maharashtra",
    postalCode: "411026",
    notes: "Tower cranes, batching plants and earthmoving equipment on hire.",
    status: "ACTIVE",
    createdAt: daysAgo(89),
  },
  {
    name: "Ganesh Cement Agencies",
    legalName: "Ganesh Cement Agencies",
    gstin: "09AAFCD7712Q1ZB",
    contactPerson: "Anil Ganesh",
    email: "ganesh.agencies@outlook.com",
    phone: "+91 93359 88420",
    addressLine1: "12/4 Gomti Nagar Extension",
    city: "Lucknow",
    state: "Uttar Pradesh",
    postalCode: "226010",
    notes: "Deactivated pending GST reconciliation for FY 2024-25.",
    status: "INACTIVE",
    createdAt: daysAgo(64),
  },
  {
    name: "Sunrise Electricals & Fittings",
    legalName: "Sunrise Electricals & Fittings",
    gstin: "27AAJFS3365N1ZC",
    contactPerson: "Pooja Sunrise",
    email: "sales@sunriseelectricals.in",
    phone: "+91 98230 77109",
    addressLine1: "Shop 31, Sitabuldi Main Road",
    city: "Nagpur",
    state: "Maharashtra",
    postalCode: "440012",
    notes: "LT switchgear, cabling and site lighting supplies.",
    status: "ACTIVE",
    createdAt: daysAgo(29),
  },
  {
    name: "Prakash Mining Services",
    legalName: "Prakash Mining Services (Prop. S. Prakash)",
    gstin: "20AALKP8890J1ZD",
    contactPerson: "Sanjay Prakash",
    email: "prakash.mining@gmail.com",
    phone: "+91 94311 60284",
    addressLine1: "Near HEC Colony, Dhurwa",
    city: "Ranchi",
    state: "Jharkhand",
    postalCode: "834004",
    notes: "Drilling, blasting and overburden removal contractors.",
    status: "ACTIVE",
    createdAt: daysAgo(11),
  },
];

async function seedAdmin(): Promise<void> {
  const existing = await db.adminUser.count();
  if (existing > 0) return;

  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase() || "admin@niyojan.com";
  const name = process.env.ADMIN_NAME?.trim() || "System Administrator";
  let password = process.env.ADMIN_INITIAL_PASSWORD ?? "";
  let generated = false;
  if (!password.trim()) {
    password = randomBytes(12).toString("base64url");
    generated = true;
  }

  await db.adminUser.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(password),
      role: "ADMIN",
      mustChangePassword: true,
    },
  });

  console.info(
    `[seed] Initial administrator created: ${email}` +
      (generated
        ? " — ADMIN_INITIAL_PASSWORD was not set, a random password was generated and is printed once below:"
        : " — change this password from Account Settings after first login."),
  );
  if (generated) console.info(`[seed] Generated initial password: ${password}`);
}

async function seedFirms(): Promise<void> {
  const existing = await db.firm.count();
  if (existing > 0) return;
  await db.firm.createMany({ data: SAMPLE_FIRMS });
  console.info(`[seed] Seeded ${SAMPLE_FIRMS.length} sample firm records (editable / deletable from the app).`);
}

/**
 * Idempotent bootstrap, checked on every server request (two COUNT queries —
 * sub-millisecond). Guarantees a fresh database is provisioned from the
 * environment on first boot, and heals itself if it is ever emptied while the
 * server is running. Concurrent first requests are safe: the admin insert is
 * guarded by the email unique constraint and failures are retried lazily.
 */
export function ensureSeeded(): Promise<void> {
  if (seeding) return seeding;
  seeding = (async () => {
    try {
      await seedAdmin();
      await seedFirms();
    } catch (error) {
      console.error("[seed] bootstrap failed:", error instanceof Error ? error.message : error);
    } finally {
      seeding = null;
    }
  })();
  return seeding;
}
