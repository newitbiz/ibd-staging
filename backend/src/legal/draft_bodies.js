/**
 * Temporary staging draft bodies for Invest in Bangladesh legal documents.
 * NEVER claim these are lawyer-approved. Label clearly for legal review.
 */

export const DRAFT_BANNER = 'Temporary draft—legal review pending';
export const LANGUAGE_PRECEDENCE =
  'English is the controlling language until a lawyer-approved Bangla translation is published. Bangla stubs are pending lawyer review.';
export const COMPANY_PLACEHOLDERS = Object.freeze({
  legalName: '[LEGAL PLACEHOLDER: company legal name]',
  registeredAddress: '[LEGAL PLACEHOLDER: registered office address]',
  registrationNumber: '[LEGAL PLACEHOLDER: company registration / trade licence number]',
  governingLaw: '[LEGAL PLACEHOLDER: governing law and dispute forum]',
  contactEmail: '[LEGAL PLACEHOLDER: legal contact email]',
});

const bannerBlock = `> **${DRAFT_BANNER}**
>
> This text is a **temporary staging draft** generated from product requirements for TEST/STAGING only.
> It is **not** lawyer-approved and must not be used in production.
> ${LANGUAGE_PRECEDENCE}
>
> Company: ${COMPANY_PLACEHOLDERS.legalName} · Address: ${COMPANY_PLACEHOLDERS.registeredAddress}
> Registration: ${COMPANY_PLACEHOLDERS.registrationNumber} · Law: ${COMPANY_PLACEHOLDERS.governingLaw}
`;

export const TEMPORARY_DRAFTS = Object.freeze({
  investor_agreement: {
    title: 'Investor Agreement (Temporary Draft)',
    changeSummary: 'Initial temporary staging draft — legal review pending',
    en: `${bannerBlock}

# Investor Agreement

**Parties.** This Investor Agreement is between **${COMPANY_PLACEHOLDERS.legalName}** ("Invest in Bangladesh" / "Platform") and you ("Investor").

## 1. Nature of the Platform
Invest in Bangladesh is a project-participation marketplace that connects Investors with Project Owners. Listing a project or accepting an application does **not** mean Invest in Bangladesh endorses, underwrites, or guarantees any project outcome.

## 2. Eligibility & Account
You must provide accurate identity and contact information. Admin-created accounts still require **your personal** acceptance of these terms at first login. An administrator cannot accept for you.

## 3. Investments Are Project-Specific
Each purchase requires a separate **Project Investment Agreement** generated from the live template + project fields. Platform terms here do not replace project-specific terms.

## 4. Fees
Administration / service fees are disclosed before payment and are separate from investment principal. Fee amounts are shown in the purchase flow.

## 5. No Advice
Nothing on Invest in Bangladesh is investment, legal, tax, or Shariah advice. You are solely responsible for your decisions.

## 6. Risk Acknowledgment (companion section)
**You acknowledge that:**
1. **Capital may be partially or entirely lost.** There is no blanket principal guarantee.
2. **Projected returns are illustrative estimates only and are not guaranteed.**
3. Project performance, delays, defaults, and market conditions can reduce or eliminate returns.
4. Invest in Bangladesh is **not a guarantor** of principal or return unless a separate lawyer-approved guarantee agreement exists.
5. Repayment debtor / security (if any) are stated only in the project-specific agreement placeholders and must be completed by counsel:
   - Repayment debtor: \`[LEGAL PLACEHOLDER: repayment debtor legal name]\`
   - Security: \`[LEGAL PLACEHOLDER: security / collateral description — none unless separately agreed]\`
6. Viewing or scrolling this document does **not** by itself prove understanding; you must actively confirm acceptance.

## 7. Evidence of Acceptance
When you tick "I agree" after viewing, Invest in Bangladesh stores immutable evidence (agreement id, version, content hash, user id, role, server timestamp, language, acceptance method, and exact snapshot). **Evidence logging is not a certified electronic signature.**

## 8. Privacy
Personal data is processed under the separate **Privacy Notice**, which you must also accept.

## 9. Marketing
Optional marketing messages are controlled by a **separate unchecked** consent. Declining marketing does not block account creation.

## 10. Changes
Published updates apply to **future** acceptances only. Material updates require a new acceptance. Historical accepted snapshots are never altered.

## 11. Contact
${COMPANY_PLACEHOLDERS.contactEmail}

---
*${DRAFT_BANNER}*
`,
    bn: `${bannerBlock}

# বিনিয়োগকারী চুক্তি (খসড়া — আইনজীবী পর্যালোচনা মুলতবি)

এটি একটি **অস্থায়ী বাংলা stub**। নিয়ন্ত্রক ভাষা: ইংরেজি। আইনজীবী-অনুমোদিত বাংলা অনুবাদ প্রকাশের আগ পর্যন্ত ইংরেজি প্রাধান্য পাবে।

- মূলধন হারানোর ঝুঁকি থাকতে পারে।
- প্রজেক্টেড রিটার্ন নিশ্চিত নয়।
- Invest in Bangladesh গ্যারান্টর নয় (আলাদা অনুমোদিত চুক্তি ছাড়া)।

*${DRAFT_BANNER} — Bangla pending lawyer review*
`,
  },

  project_owner_agreement: {
    title: 'Project Owner Agreement (Temporary Draft)',
    changeSummary: 'Initial temporary staging draft — legal review pending',
    en: `${bannerBlock}

# Project Owner Agreement

**Parties.** Between **${COMPANY_PLACEHOLDERS.legalName}** ("Platform") and you ("Project Owner").

## 1. Listing Projects
You may create and submit projects for review. Publication requires Platform approval. Misleading statements, omitted material risks, or fabricated documents are prohibited.

## 2. Accuracy & Updates
You must keep project information accurate, including funding status, milestones, and material adverse changes. Investors rely on your disclosures.

## 3. Instrument & Principal
Each project must state an \`instrument_type\`. **There is no blanket principal guarantee.** Invest in Bangladesh is not a guarantor without a separate approved legal agreement. Repayment debtor and security fields are legal placeholders until counsel completes them.

## 4. Fees & Disbursements
Platform fees, review fees, and disbursement rules (if any) apply as configured by Super Admin and disclosed in-product.

## 5. Investor Communications
You must respond to Platform requests and provide performance information in good faith. You must not solicit off-platform payments that circumvent Platform records.

## 6. Dual Role
If you also act as an Investor, investing in your own project is forbidden. Adding the Owner role to an Investor account requires a **separate** acceptance of this Agreement.

## 7. Evidence
Acceptance is recorded immutably. Evidence logging ≠ certified signature.

## 8. Privacy
You also accept the Privacy Notice for processing of your personal and business data.

## 9. Changes
Publication of a new version affects **future** acceptances only.

---
*${DRAFT_BANNER}*
`,
    bn: `${bannerBlock}

# প্রজেক্ট মালিক চুক্তি (খসড়া — আইনজীবী পর্যালোচনা মুলতবি)

অস্থায়ী বাংলা stub। নিয়ন্ত্রক ভাষা: ইংরেজি।

*${DRAFT_BANNER} — Bangla pending lawyer review*
`,
  },

  project_investment_agreement_template: {
    title: 'Project Investment Agreement Template (Temporary Draft)',
    changeSummary: 'Initial temporary staging template — filled at purchase',
    en: `${bannerBlock}

# Project Investment Agreement

**Transaction-specific.** This agreement is generated from the published template and **live project fields** at the time of purchase. Historical accepted copies are never altered.

## Parties
- **Investor:** {{investor_legal_name}} (user id {{investor_user_id}})
- **Issuer / Project Owner legal name:** {{issuer_owner_legal_name}}
- **Platform:** ${COMPANY_PLACEHOLDERS.legalName} (facilitator only — not guarantor unless separately agreed)

## Project
- **Title:** {{project_title}}
- **Project id:** {{project_id}}
- **Application id:** {{application_id}}
- **Project terms version:** {{project_terms_version}}
- **Template version:** {{template_version}}

## Investment terms (live fields)
| Field | Value |
|---|---|
| Instrument type | {{instrument_type}} |
| Units | {{units}} |
| Unit price (poisha) | {{unit_price_poisha}} |
| Principal / investment (poisha) | {{principal_poisha}} |
| Administration fee (poisha) | {{fee_poisha}} |
| Total payable (poisha) | {{total_payable_poisha}} |
| Duration (days) | {{duration_days}} |
| Maturity rule | {{maturity_rule}} |
| Projected return (illustrative) | {{projected_return}} |
| Loss risks | {{loss_risks}} |
| Exit / refund | {{exit_refund_rule}} |
| Payment recipient | {{payment_recipient}} |
| Repayment debtor | {{repayment_debtor}} |
| Security | {{security_placeholder}} |
| IEC guarantor status | {{iec_guarantor_status}} |

## Risk acknowledgments (required before payment)
1. **Capital may be lost** — I understand principal is not guaranteed.
2. **Projection not guaranteed** — illustrative estimates only; not withdrawable as entitlement until Approved distributions (if any).

## Acceptance
Investor must **View** this agreement; checkbox enables only after view. Fresh acceptance is required for each transaction. If project terms or template version change, a new version must be accepted.

## After verified payment + allocation
A transaction-specific copy including allocation id and maturity timestamp will be available in the Investor account and emailed with delivery/retry tracking. Memory of sending is not proof of delivery.

## Placeholders remaining for counsel
${COMPANY_PLACEHOLDERS.legalName}; ${COMPANY_PLACEHOLDERS.registeredAddress}; ${COMPANY_PLACEHOLDERS.governingLaw}; repayment debtor; security; exit/refund; payment recipient.

---
*${DRAFT_BANNER}*
`,
    bn: `${bannerBlock}

# প্রজেক্ট বিনিয়োগ চুক্তি টেমপ্লেট (খসড়া)

অস্থায়ী বাংলা stub। নিয়ন্ত্রক ভাষা: ইংরেজি। ক্রয়ের সময় ইংরেজি টেমপ্লেট পূরণ হবে।

*${DRAFT_BANNER} — Bangla pending lawyer review*
`,
  },

  privacy_notice: {
    title: 'Privacy Notice (Temporary Draft)',
    changeSummary: 'Initial temporary staging draft — legal review pending',
    en: `${bannerBlock}

# Privacy Notice

**Controller.** ${COMPANY_PLACEHOLDERS.legalName}, ${COMPANY_PLACEHOLDERS.registeredAddress}.

## What we collect
Account identifiers (email, mobile), profile/KYC fields you submit, device/IP/user-agent when needed for security and agreement evidence, payment references, and support messages.

## Why we process
To operate accounts, process applications and payments, record agreement acceptances, prevent fraud, and meet legal obligations. Marketing uses a **separate optional consent** (unchecked by default).

## Agreement evidence
We store immutable acceptance records (version, content hash, snapshot, timestamp, role, method). IP/UA only as needed with retention limits. **Evidence logging is not a certified signature.**

## Sharing
With Project Owners only as needed for their project; with processors who host our staging/production infrastructure; with authorities when required by law. We do not sell personal data.

## Retention
Kept for the life of the account relationship and as required for dispute/audit. Seed/demo accounts never receive fabricated acceptance evidence.

## Your choices
Access/correction requests: ${COMPANY_PLACEHOLDERS.contactEmail}. You may withdraw marketing consent without affecting necessary service processing.

## International / Bangladesh
\`[LEGAL PLACEHOLDER: cross-border transfer and BD data-protection basis]\`

---
*${DRAFT_BANNER}*
`,
    bn: `${bannerBlock}

# গোপনীয়তা বিজ্ঞপ্তি (খসড়া — আইনজীবী পর্যালোচনা মুলতবি)

অস্থায়ী বাংলা stub। নিয়ন্ত্রক ভাষা: ইংরেজি।

*${DRAFT_BANNER} — Bangla pending lawyer review*
`,
  },
});

export function listDocumentTypes() {
  return Object.keys(TEMPORARY_DRAFTS);
}
