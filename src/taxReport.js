import { StrKey } from '@stellar/stellar-sdk';
import { store } from './store.js';
import { config } from './config.js';
import { stroopsToUsdc } from './pricing.js';
import { getWorkerCredits, getWorkerWithdrawals, getEarnersForYear, getWorkerEarningYears } from './earnings.js';

/**
 * Annual earnings summary for US-based workers, shaped like a 1099-NEC
 * (nonemployee compensation) so a worker or their accountant can file from
 * it, and so the platform can see who crosses the reporting threshold.
 *
 * What this is NOT: a filed IRS form. It's built from this backend's own
 * earnings ledger (earnings.js), which values USDC at 1:1 USD at the time
 * of credit. Each line carries its payout transaction hash, so any figure
 * can be checked against the chain.
 *
 * Income is counted when a worker is CREDITED (resolve() lands and their
 * Owed goes up), not when they withdraw. The credit is when the worker
 * gains control of the funds. Withdrawals are listed separately for
 * reconciliation only.
 *
 * Tax profile (W-9-style details): only the last four digits of the TIN
 * are stored, never the full number. The KV store here isn't somewhere a
 * full SSN/EIN should live. A real 1099 filing needs the full TIN, and
 * that belongs with a dedicated W-9 / TIN-matching provider, keyed by the
 * same worker address.
 */

const PROFILE_PREFIX = 'tax-profile:';
const STROOPS_PER_CENT = 100_000n;
const US_STATE = /^[A-Z]{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Earliest tax year the platform could have recorded earnings. Derived
 * from the platform's launch date (config.launchDate) rather than a
 * hardcoded constant, so the floor moves with the platform instead of
 * silently drifting out of date. Falls back to 2020 if no launch date is
 * configured. */
export function earliestTaxYear() {
  const launch = config.launchDate ? new Date(config.launchDate) : null;
  if (!launch || Number.isNaN(launch.getTime())) return 2020;
  return launch.getUTCFullYear();
}

export class TaxReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Parses a tax year, defaulting to the previous calendar year (the one
 * people actually file for). Rejects the future and anything before the
 * platform could have existed. */
export function parseTaxYear(value, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const minYear = earliestTaxYear();
  if (value === undefined || value === null || value === '') return currentYear - 1;
  const year = Number(value);
  if (!Number.isInteger(year) || year < minYear || year > currentYear) {
    throw new TaxReportError(`year must be an integer between ${minYear} and ${currentYear}`);
  }
  return year;
}

/** USD with 2 decimals, rounded half-up to the cent, from USDC stroops. */
export function stroopsToUsd(stroops) {
  const cents = (BigInt(stroops) + STROOPS_PER_CENT / 2n) / STROOPS_PER_CENT;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

function cleanString(value, field, maxLength = 200) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TaxReportError(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new TaxReportError(`${field} must be at most ${maxLength} characters`);
  return trimmed || null;
}

export async function getTaxProfile(workerAddress) {
  return store.get(PROFILE_PREFIX + workerAddress);
}

/**
 * Saves a worker's W-9-style details. `tin` may be passed in full or as
 * just the last four digits. Either way, only the last four are kept.
 */
export async function saveTaxProfile(workerAddress, input = {}) {
  if (!StrKey.isValidEd25519PublicKey(workerAddress)) {
    throw new TaxReportError('a tax profile needs a real Stellar worker address');
  }

  const usPerson = input.usPerson;
  if (typeof usPerson !== 'boolean') throw new TaxReportError('usPerson must be a boolean');

  const legalName = cleanString(input.legalName, 'legalName');
  if (!legalName) throw new TaxReportError('legalName is required');
  const businessName = cleanString(input.businessName, 'businessName');

  let tinType = null;
  let tinLast4 = null;
  if (usPerson) {
    tinType = input.tinType;
    if (tinType !== 'SSN' && tinType !== 'EIN') throw new TaxReportError('tinType must be "SSN" or "EIN" for a US person');
    const digits = String(input.tin ?? '').replace(/\D/g, '');
    if (digits.length !== 4 && digits.length !== 9) {
      throw new TaxReportError('tin must be the full 9-digit number or its last 4 digits');
    }
    tinLast4 = digits.slice(-4);
  }

  const addr = input.mailingAddress || {};
  const mailingAddress = {
    line1: cleanString(addr.line1, 'mailingAddress.line1'),
    line2: cleanString(addr.line2, 'mailingAddress.line2'),
    city: cleanString(addr.city, 'mailingAddress.city', 100),
    state: cleanString(addr.state, 'mailingAddress.state', 2)?.toUpperCase() ?? null,
    postalCode: cleanString(addr.postalCode, 'mailingAddress.postalCode', 10),
    country: (cleanString(addr.country, 'mailingAddress.country', 2) || (usPerson ? 'US' : null))?.toUpperCase() ?? null,
  };
  if (usPerson) {
    if (!mailingAddress.line1 || !mailingAddress.city || !mailingAddress.postalCode) {
      throw new TaxReportError('mailingAddress.line1, city, and postalCode are required for a US person');
    }
    if (!mailingAddress.state || !US_STATE.test(mailingAddress.state)) {
      throw new TaxReportError('mailingAddress.state must be a 2-letter US state code');
    }
  }

  const profile = {
    usPerson,
    legalName,
    businessName,
    tinType,
    tinLast4,
    mailingAddress,
    updatedAt: Date.now(),
  };
  await store.set(PROFILE_PREFIX + workerAddress, profile); // durable, no TTL
  return profile;
}

function maskTin(profile) {
  if (!profile?.tinLast4) return null;
  return profile.tinType === 'EIN' ? `**-***${profile.tinLast4}` : `***-**-${profile.tinLast4}`;
}

/** Builds one worker's summary for one tax year. `includeLines` adds the
 * per-credit and per-withdrawal detail (used for the worker's own export;
 * left off the admin bulk listing to keep it small). */
export async function buildTaxSummary(workerAddress, year, { includeLines = false } = {}) {
  const [credits, withdrawals, profile] = await Promise.all([
    getWorkerCredits(workerAddress, year),
    getWorkerWithdrawals(workerAddress, year),
    getTaxProfile(workerAddress),
  ]);

  const monthlyStroops = Array.from({ length: 12 }, () => 0n);
  let grossStroops = 0n;
  for (const c of credits) {
    const amount = BigInt(c.amountStroops);
    grossStroops += amount;
    monthlyStroops[new Date(c.creditedAt).getUTCMonth()] += amount;
  }
  const withdrawnStroops = withdrawals.reduce((sum, w) => sum + BigInt(w.amountStroops), 0n);

  const thresholdCents = BigInt(Math.round(config.tax.reportingThresholdUsd * 100));
  const grossCents = (grossStroops + STROOPS_PER_CENT / 2n) / STROOPS_PER_CENT;

  const summary = {
    form: '1099-NEC-style summary (informational, not a filed IRS form)',
    taxYear: year,
    currency: 'USD',
    valuation: 'USDC credited on-chain, valued at 1 USDC = 1 USD at time of credit',
    payer: {
      name: config.tax.payerName || null,
      tin: config.tax.payerTin || null,
      address: config.tax.payerAddress || null,
    },
    recipient: {
      stellarAddress: workerAddress,
      usPerson: profile?.usPerson ?? null,
      legalName: profile?.legalName ?? null,
      businessName: profile?.businessName ?? null,
      tinType: profile?.tinType ?? null,
      tinMasked: maskTin(profile),
      mailingAddress: profile?.mailingAddress ?? null,
    },
    // Box 1 of a 1099-NEC.
    nonemployeeCompensation: stroopsToUsd(grossStroops),
    grossEarningsStroops: grossStroops.toString(),
    grossEarningsUsdc: stroopsToUsdc(grossStroops),
    federalIncomeTaxWithheld: '0.00',
    creditCount: credits.length,
    monthly: monthlyStroops.map((s, i) => ({ month: MONTHS[i], amount: stroopsToUsd(s), amountStroops: s.toString() })),
    withdrawals: {
      count: withdrawals.length,
      total: stroopsToUsd(withdrawnStroops),
      totalStroops: withdrawnStroops.toString(),
    },
    reportingThresholdUsd: config.tax.reportingThresholdUsd,
    meetsReportingThreshold: grossCents >= thresholdCents,
    // Everything a US filing needs that this backend doesn't have yet.
    missing: [
      ..

/* … truncated 4704 chars — edit only what you need near the top … */
