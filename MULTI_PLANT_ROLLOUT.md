# PowerPlant360 multi-plant migration — Phase 1

Date: 2026-10-26
Production Supabase migration: `powerplant360_multi_plant_foundation_20261026`

## Completed and verified
- Added RLS-enabled and browser-restricted `pp360_plants`, `pp360_plant_memberships`, `pp360_plant_invitations` tables.
- Added nullable `plant_id` to `documents` and `api_usage`, preserving backward compatibility.
- Registered existing PowerPlant360 plant from approved `plant_settings`.
- Backfilled 234/234 existing documents to the original plant.
- Recorded 3 original plant memberships: one `super_admin`, one `engineer`, one `viewer`.
- Verified new tables have RLS enabled and no anon/authenticated table grants.

## NOT ACTIVE / MUST NOT ENABLE YET
- Invitation issuance or redemption
- Plant Admin accounts or registration
- Any new plant or tenant's access to documents
- Plant-scoped Edge Function search, indexing and storage access
- Changes to legacy `user_roles` / existing policy behavior

## Mandatory remaining work before inviting another Plant Admin
1. Backup and audit existing Supabase Storage, document references, and user-role relations.
2. Update all document CRUD, storage policies and all search/indexing Edge Functions to enforce membership by `plant_id`. Ensure storage object paths map to the same plant as document rows.
3. Audit `plant_settings`, search history, extracted text, usage data, user invitations, and signed download URL generation for cross-tenant leakage.
4. Replace global auth `admin` logic with explicit `super_admin` and `plant_admin` authorization. Server-side authorization is mandatory; UI hiding is not security.
5. Implement Super Admin-only 48-hour, email-bound, single-use invitation tokens stored as hashes, with explicit approval and rejection.
6. Implement Plant Admin-only own-plant users, documents and details. Engineers may submit correction requests but must not change shared approved documents; viewers remain read-only.
7. Cross-plant deny/allow tests (reads, updates, deletes, signed URLs, document search, previews and indexes), and legacy-account regression tests.
8. Deploy only after all isolation tests pass, with a documented rollback plan.

## Engineering safety
Existing PowerPlant360 production must continue operating as a single plant while the multi-tenant work is incomplete. Do not add Plant Admins or change the existing RLS policies until all data-access paths are hardened and verified.
