import { DomainError } from './domain.js';
import { encryptField, last4Digits, last4Alnum, maskLast4 } from './field_encryption.js';

export const KYC_STATUSES = Object.freeze(['not_started', 'pending', 'approved', 'rejected']);
export const BANK_VERIFICATION_STATUSES = Object.freeze(['pending', 'verified', 'rejected']);
export const ACCOUNT_TYPES = Object.freeze(['savings', 'current', 'other']);
export const MFS_TYPES = Object.freeze(['bkash', 'nagad', 'rocket', 'upay', 'other']);

const PROFILE_FIELDS = Object.freeze([
  'fullName',
  'phone',
  'dateOfBirth',
  'nationality',
  'occupation',
  'presentAddress',
  'permanentAddress',
  'nomineeName',
  'nomineeRelationship',
  'nomineePhone',
]);

const BANK_REQUIRED = Object.freeze([
  'accountHolderName',
  'bankName',
  'branchName',
  'accountType',
  'accountNumber',
  'routingNumber',
]);

function nonEmpty(value, field, min = 2, max = 200) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new DomainError('VALIDATION_ERROR', `${field} must be ${min}–${max} characters`, 400);
  }
  return value.trim();
}

function optionalText(value, field, max = 500) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new DomainError('VALIDATION_ERROR', `${field} must be at most ${max} characters`, 400);
  }
  return value.trim();
}

function normalizePhone(value, field = 'phone') {
  const raw = nonEmpty(value, field, 8, 20);
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 8) {
    throw new DomainError('VALIDATION_ERROR', `${field} must include at least 8 digits`, 400);
  }
  return digits;
}

function normalizeDob(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new DomainError('VALIDATION_ERROR', 'dateOfBirth must be YYYY-MM-DD', 400);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new DomainError('VALIDATION_ERROR', 'dateOfBirth is invalid', 400);
  }
  const now = new Date();
  const ageMs = now.getTime() - d.getTime();
  const years = ageMs / (365.25 * 24 * 3600 * 1000);
  if (years < 18 || years > 120) {
    throw new DomainError('VALIDATION_ERROR', 'Investor must be between 18 and 120 years old', 400);
  }
  return s;
}

export function validateProfilePatch(input = {}) {
  const out = {};
  if (input.fullName !== undefined) out.fullName = nonEmpty(input.fullName, 'fullName', 2, 120);
  if (input.phone !== undefined) out.phone = normalizePhone(input.phone, 'phone');
  if (input.dateOfBirth !== undefined) out.dateOfBirth = normalizeDob(input.dateOfBirth);
  if (input.nationality !== undefined) out.nationality = nonEmpty(input.nationality, 'nationality', 2, 80);
  if (input.occupation !== undefined) out.occupation = nonEmpty(input.occupation, 'occupation', 2, 120);
  if (input.presentAddress !== undefined) {
    out.presentAddress = nonEmpty(input.presentAddress, 'presentAddress', 5, 500);
  }
  if (input.permanentAddress !== undefined) {
    out.permanentAddress = nonEmpty(input.permanentAddress, 'permanentAddress', 5, 500);
  }
  if (input.nomineeName !== undefined) out.nomineeName = nonEmpty(input.nomineeName, 'nomineeName', 2, 120);
  if (input.nomineeRelationship !== undefined) {
    out.nomineeRelationship = nonEmpty(input.nomineeRelationship, 'nomineeRelationship', 2, 80);
  }
  if (input.nomineePhone !== undefined) out.nomineePhone = normalizePhone(input.nomineePhone, 'nomineePhone');
  // Investors cannot self-set kycStatus via profile patch.
  if (input.kycStatus !== undefined) {
    throw new DomainError('FORBIDDEN', 'KYC status cannot be changed via profile update', 403);
  }
  if (Object.keys(out).length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'No profile fields to update', 400);
  }
  return out;
}

export function validateBankUpsert(input = {}) {
  const accountHolderName = nonEmpty(input.accountHolderName, 'accountHolderName', 2, 120);
  const bankName = nonEmpty(input.bankName, 'bankName', 2, 120);
  const branchName = nonEmpty(input.branchName, 'branchName', 2, 120);
  const accountType = String(input.accountType || '').trim().toLowerCase();
  if (!ACCOUNT_TYPES.includes(accountType)) {
    throw new DomainError('VALIDATION_ERROR', `accountType must be one of: ${ACCOUNT_TYPES.join(', ')}`, 400);
  }
  const accountNumber = String(input.accountNumber || '').replace(/\s+/g, '');
  if (!/^\d{8,20}$/.test(accountNumber)) {
    throw new DomainError('VALIDATION_ERROR', 'accountNumber must be 8–20 digits', 400);
  }
  const routingNumber = String(input.routingNumber || '').replace(/\s+/g, '');
  if (!/^[0-9A-Za-z]{4,20}$/.test(routingNumber)) {
    throw new DomainError('VALIDATION_ERROR', 'routingNumber must be 4–20 alphanumeric characters', 400);
  }

  let mfsType = null;
  let mfsNumber = null;
  if (input.mfsType != null && String(input.mfsType).trim() !== '') {
    mfsType = String(input.mfsType).trim().toLowerCase();
    if (!MFS_TYPES.includes(mfsType)) {
      throw new DomainError('VALIDATION_ERROR', `mfsType must be one of: ${MFS_TYPES.join(', ')}`, 400);
    }
    mfsNumber = String(input.mfsNumber || '').replace(/\s+/g, '');
    if (!/^\d{8,15}$/.test(mfsNumber)) {
      throw new DomainError('VALIDATION_ERROR', 'mfsNumber must be 8–15 digits when mfsType is set', 400);
    }
  } else if (input.mfsNumber != null && String(input.mfsNumber).trim() !== '') {
    throw new DomainError('VALIDATION_ERROR', 'mfsType is required when mfsNumber is provided', 400);
  }

  return {
    accountHolderName,
    bankName,
    branchName,
    accountType,
    accountNumber,
    routingNumber,
    mfsType,
    mfsNumber,
  };
}

export function encryptBankSecrets(validated) {
  return {
    accountHolderName: validated.accountHolderName,
    bankName: validated.bankName,
    branchName: validated.branchName,
    accountType: validated.accountType,
    accountNumberCiphertext: encryptField(validated.accountNumber),
    accountNumberLast4: last4Digits(validated.accountNumber),
    routingNumberCiphertext: encryptField(validated.routingNumber),
    routingNumberLast4: last4Alnum(validated.routingNumber),
    mfsType: validated.mfsType,
    mfsNumberCiphertext: validated.mfsNumber ? encryptField(validated.mfsNumber) : null,
    mfsNumberLast4: validated.mfsNumber ? last4Digits(validated.mfsNumber) : null,
  };
}

export function mapProfileRow(row, userRow = {}) {
  if (!row && !userRow?.id) return null;
  const fullName = row?.full_name || null;
  const phone = row?.phone || userRow.mobile || null;
  const profile = {
    userId: row?.user_id || userRow.id,
    fullName,
    phone,
    dateOfBirth: row?.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
    nationality: row?.nationality || null,
    occupation: row?.occupation || null,
    presentAddress: row?.present_address || null,
    permanentAddress: row?.permanent_address || null,
    nomineeName: row?.nominee_name || null,
    nomineeRelationship: row?.nominee_relationship || null,
    nomineePhone: row?.nominee_phone || null,
    kycStatus: row?.kyc_status || 'not_started',
    changeReason: row?.change_reason || null,
    changeRequestedAt: row?.change_requested_at || null,
    previousKycStatus: row?.previous_kyc_status || null,
    email: userRow.email || null,
    mobile: userRow.mobile || null,
    emailVerified: Boolean(userRow.email_verified_at),
    emailVerifiedAt: userRow.email_verified_at || null,
    phoneVerified: Boolean(userRow.phone_verified_at),
    phoneVerifiedAt: userRow.phone_verified_at || null,
    status: userRow.status || null,
  };
  profile.completion = computeProfileCompletion(profile, null);
  return profile;
}

export function mapBankRowMasked(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    accountHolderName: row.account_holder_name,
    bankName: row.bank_name,
    branchName: row.branch_name,
    accountType: row.account_type,
    accountNumberMasked: maskDisplay(row.account_number_last4),
    accountNumberLast4: row.account_number_last4,
    routingNumberMasked: maskDisplay(row.routing_number_last4),
    routingNumberLast4: row.routing_number_last4,
    mfsType: row.mfs_type || null,
    mfsNumberMasked: row.mfs_number_last4 ? maskDisplay(row.mfs_number_last4) : null,
    mfsNumberLast4: row.mfs_number_last4 || null,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at || null,
    verifiedBy: row.verified_by || null,
    verificationNote: row.verification_note || null,
    updatedAt: row.updated_at || null,
    createdAt: row.created_at || null,
  };
}

function maskDisplay(last4) {
  if (!last4) return null;
  return `****${String(last4).slice(-4)}`;
}

export function computeProfileCompletion(profile, bankMasked) {
  const checks = PROFILE_FIELDS.map((key) => {
    const v = profile?.[key];
    return Boolean(v != null && String(v).trim() !== '');
  });
  const bankChecks = BANK_REQUIRED.map((key) => {
    if (!bankMasked) return false;
    if (key === 'accountNumber') return Boolean(bankMasked.accountNumberLast4);
    if (key === 'routingNumber') return Boolean(bankMasked.routingNumberLast4);
    const map = {
      accountHolderName: bankMasked.accountHolderName,
      bankName: bankMasked.bankName,
      branchName: bankMasked.branchName,
      accountType: bankMasked.accountType,
    };
    return Boolean(map[key]);
  });
  const total = checks.length + bankChecks.length;
  const done = [...checks, ...bankChecks].filter(Boolean).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return {
    percent,
    complete: percent === 100,
    missingProfileFields: PROFILE_FIELDS.filter((k, i) => !checks[i]),
    missingBankFields: bankMasked
      ? BANK_REQUIRED.filter((k, i) => !bankChecks[i])
      : [...BANK_REQUIRED],
    hasBank: Boolean(bankMasked),
  };
}

export function attachCompletion(profile, bankMasked) {
  if (!profile) return profile;
  return {
    ...profile,
    completion: computeProfileCompletion(profile, bankMasked),
  };
}

/** Audit-safe bank snapshot — never includes ciphertext or plaintext numbers. */
export function bankAuditSnapshot(masked) {
  if (!masked) return null;
  return {
    accountHolderName: masked.accountHolderName,
    bankName: masked.bankName,
    branchName: masked.branchName,
    accountType: masked.accountType,
    accountNumberLast4: masked.accountNumberLast4,
    routingNumberLast4: masked.routingNumberLast4,
    mfsType: masked.mfsType,
    mfsNumberLast4: masked.mfsNumberLast4,
    verificationStatus: masked.verificationStatus,
  };
}

export function profileAuditSnapshot(profile) {
  if (!profile) return null;
  return {
    fullName: profile.fullName,
    phone: profile.phone,
    dateOfBirth: profile.dateOfBirth,
    nationality: profile.nationality,
    occupation: profile.occupation,
    presentAddress: profile.presentAddress,
    permanentAddress: profile.permanentAddress,
    nomineeName: profile.nomineeName,
    nomineeRelationship: profile.nomineeRelationship,
    nomineePhone: profile.nomineePhone,
    kycStatus: profile.kycStatus,
  };
}

export { maskLast4 };
