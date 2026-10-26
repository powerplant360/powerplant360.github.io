# Plant storage limits — 26 October 2026

- Existing plant total: 234 document records, 247.57 MiB of recorded file sizes, as verified before release.
- Each plant has `pp360_plants.storage_quota_bytes` defaulting to 314572800 bytes (300 MiB).
- Database trigger `pp360_document_storage_quota` checks inserts and changes to file size/plant ID, serializing quota checks per plant row.
- `pp360_my_storage_quota()` reports authorized administrators' own plant totals.
- `pp360_request_storage_increase()` records an approval request; `pp360_review_storage_increase()` allows only a `super_admin` membership to grant/reject it.
- `pp360_my_storage_requests()` returns own-plant requests and cross-plant requests only to Super Admin.
- Existing documents have not been removed, compressed or altered.
- Stored Documents now displays recorded size per file, used quota, remaining space, selected-department total and all-department totals. Default upload path pre-checks 25 MiB per new file and available plant quota.
- **Security caveat**: Storage objects upload before a documents row is written; a rejected database insert triggers cleanup in the ordinary client flow. Direct storage API uploads outside that client are not yet bound to plant quota. Enforce tenant-aware storage policy/secure upload endpoint before independent Plant Admin accounts are enabled.
- **Security caveat**: All independent Plant Admin onboarding remains disabled until document RLS, storage object access, search/indexing and signed URL paths are plant-isolated and cross-plant tests pass.
- The storage quota is a project allocation, not a guarantee that the shared Supabase plan has 300 MiB available per tenant.
