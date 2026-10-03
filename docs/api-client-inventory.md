# Web API client inventory (GAP-I01 / GAP-I02)

> GENERATED FILE — regenerate with `node scripts/api-client-inventory.mjs`.

Mechanical analysis of `apps/web/lib/api/endpoints.ts` against the
`apps/api` controller surface and the web UI sources. "No UI caller"
means no static reference outside the client barrel — these are
server-first capabilities (feature-availability gap, product
backlog), NOT defects. No code is deleted as part of this finding.

## Summary

| Metric | Count |
| --- | ---: |
| Exported wrappers in endpoints.ts | 412 |
| Wrappers matching a backend route | 403 |
| Wrappers with backend route but no UI caller (GAP-I01) | 74 |
| Near-duplicate name groups with distinct backends (GAP-I02) | 8 |

## GAP-I01 — wrappers with a backend route but no web UI caller

Intentional server-first endpoints are marked where verified (see the
Notes column); everything else is an unwired capability — track as
product backlog.

| Wrapper | Backend path | Notes |
| --- | --- | --- |
| `adminSweepOutbox` | `/admin/outbox/sweep` | admin-console surface (no web admin UI wired) |
| `fetchAgentReconciliation` | `/agent-banking/agents/${encodeURIComponent(agentId)}/reconciliation` | — |
| `fetchSession` | `/auth/session` | — |
| `listBuyerGroups` | `/buyer-groups` | — |
| `fetchCampusClub` | `/campus-clubs/${encodeURIComponent(id)}` | — |
| `checkoutOrder` | `/checkout/orders` | intentional server-first: order creation ships via POST /listings/{}/orders; this alternate path is unused by design |
| `fetchCreditLoan` | `/credit/applications/${encodeURIComponent(id)}` | — |
| `listCreditCollateral` | `/credit/applications/${encodeURIComponent(loanId)}/collateral` | — |
| `applyForGroupCreditLoan` | `/credit/applications/group` | — |
| `listCreditGroups` | `/credit/groups` | — |
| `createCreditProduct` | `/credit/products` | — |
| `listDraftOrders` | `/draft-orders` | — |
| `confirmDraftOrder` | `/draft-orders/${encodeURIComponent(id)}/confirm` | — |
| `fetchFarmPlot` | `/farms/plots/${encodeURIComponent(id)}` | — |
| `removeFarmPlot` | `/farms/plots/${encodeURIComponent(id)}` | — |
| `listLenders` | `/finance/lenders` | — |
| `fetchLoan` | `/finance/loans/${encodeURIComponent(id)}` | — |
| `createGeoBoundary` | `/geo/boundaries` | — |
| `fetchGeoCell` | `/geo/cells/${encodeURIComponent(h3)}` | — |
| `checkGeoContains` | `/geo/contains` | — |
| `fetchFarmsNear` | `/geo/farms/near` | — |
| `fetchSubsidyIdentityStatus` | `/input-vouchers/identity/status` | — |
| `fetchSubsidyBeneficiaries` | `/input-vouchers/programmes/${encodeURIComponent(programmeId)}/beneficiaries` | — |
| `closeSubsidyProgramme` | `/input-vouchers/programmes/${encodeURIComponent(id)}/close` | — |
| `voidSubsidyVoucher` | `/input-vouchers/vouchers/${encodeURIComponent(id)}/void` | — |
| `fetchInvoice` | `/invoices/${encodeURIComponent(id)}` | — |
| `fetchKnowledgeResource` | `/knowledge-resources/${encodeURIComponent(id)}` | — |
| `listListingReviews` | `/listings/${encodeURIComponent(listingId)}/reviews` | — |
| `createListingReview` | `/listings/${encodeURIComponent(listingId)}/reviews` | — |
| `listVariants` | `/listings/${encodeURIComponent(listingId)}/variants` | — |
| `createVariant` | `/listings/${encodeURIComponent(listingId)}/variants` | — |
| `listDisbursementsForBeneficiary` | `/livestock-finance/disbursements/beneficiary/${encodeURIComponent(userId)}` | — |
| `assessInsuranceClaim` | `/livestock-finance/insurance/claims/${encodeURIComponent(id)}/assess` | — |
| `settleInsuranceClaim` | `/livestock-finance/insurance/claims/${encodeURIComponent(id)}/settle` | — |
| `fetchInsurancePolicy` | `/livestock-finance/insurance/policies/${encodeURIComponent(id)}` | — |
| `cancelInsurancePolicy` | `/livestock-finance/insurance/policies/${encodeURIComponent(id)}/cancel` | — |
| `lapseInsurancePolicy` | `/livestock-finance/insurance/policies/${encodeURIComponent(id)}/lapse` | — |
| `defaultLien` | `/livestock-finance/liens/${encodeURIComponent(id)}/default` | — |
| `listLotMovements` | `/livestock-health/lots/${encodeURIComponent(lotId)}/movements` | — |
| `fetchAggregationPoint` | `/livestock-partners/aggregation-points/${encodeURIComponent(id)}` | — |
| `ingestColdChainReading` | `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/cold-chain` | — |
| `listColdChainReadings` | `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/cold-chain` | — |
| `unassignLotFromPoint` | `/livestock-partners/aggregation-points/${encodeURIComponent(pointId)}/lots/${encodeURIComponent(lotId)}` | — |
| `listMyAggregationPoints` | `/livestock-partners/aggregation-points/mine` | — |
| `fetchLivestockPassport` | `/livestock-passport/${encodeURIComponent(id)}` | — |
| `fetchExportDocument` | `/livestock-trade/export-documents/${encodeURIComponent(id)}` | — |
| `revokeCertifiedListing` | `/livestock-trade/listings/${encodeURIComponent(id)}/revoke` | — |
| `fetchOfftakeContract` | `/livestock-trade/offtake-contracts/${encodeURIComponent(id)}` | — |
| `createOfftakeTemplate` | `/livestock-trade/offtake-templates` | — |
| `updateOfftakeTemplate` | `/livestock-trade/offtake-templates/${encodeURIComponent(id)}` | — |
| `archiveOfftakeTemplate` | `/livestock-trade/offtake-templates/${encodeURIComponent(id)}/archive` | — |
| `updateAnimal` | `/livestock/animals/${encodeURIComponent(id)}` | — |
| `createEquipmentListing` | `/mechanization/listings` | — |
| `adminRetryDelivery` | `/notifications/deliveries/${encodeURIComponent(notificationId)}/retry` | — |
| `adminDeliveryDeadLetters` | `/notifications/deliveries/dead-letters` | — |
| `adminSweepDeliveries` | `/notifications/deliveries/sweep` | — |
| `cancelOrderWithRestock` | `/orders/${encodeURIComponent(orderId)}/cancel` | — |
| `editOrderQuantity` | `/orders/${encodeURIComponent(orderId)}/edit` | — |
| `requestReturn` | `/orders/${encodeURIComponent(orderId)}/returns` | — |
| `fetchPodcastEpisode` | `/podcast-episodes/${encodeURIComponent(id)}` | — |
| `listPriceLists` | `/price-lists` | — |
| `fetchProfile` | `/profiles/${encodeURIComponent(userId)}` | — |
| `createPromotion` | `/promotions` | — |
| `transitionReturn` | `/returns/${encodeURIComponent(id)}/transition` | — |
| `fetchSellerRating` | `/sellers/${encodeURIComponent(userId)}/rating` | — |
| `quoteServiceBooking` | `/service-bookings/${encodeURIComponent(id)}/quote` | — |
| `addVslaMember` | `/vsla-carbon/groups/${encodeURIComponent(groupId)}/members` | — |
| `fetchWarehouseDeposit` | `/warehouse/deposits/${encodeURIComponent(id)}` | — |
| `gradeWarehouseDeposit` | `/warehouse/deposits/${encodeURIComponent(id)}/grading` | — |
| `issueWarehouseReceipt` | `/warehouse/deposits/${encodeURIComponent(id)}/receipt` | — |
| `registerWarehouse` | `/warehouse/warehouses` | — |
| `fetchWarehouse` | `/warehouse/warehouses/${encodeURIComponent(id)}` | — |
| `refreshWarehouseCertification` | `/warehouse/warehouses/${encodeURIComponent(id)}/certification` | — |
| `fetchWebinar` | `/webinars/${encodeURIComponent(id)}` | — |

## GAP-I02 — near-duplicate wrapper names (verified distinct backends)

Same stem, different wrapper names, DIFFERENT backend routes — no two
wrappers map to the same method+path (no true duplicates). Naming
ambiguity only; renames are optional. Register-verified examples:
`listMyInsurancePolicies` (livestock indemnity) vs
`fetchMyInsurancePolicies` (parametric); `fetchCreditScore` (finance)
vs `fetchCreditScoreAssessment` (credit suite); legacy `/privacy/*`
consents vs NDPA `/compliance/*` consents.

| Stem | Wrapper | Backend path |
| --- | --- | --- |
| aggregationpoint | `createAggregationPoint` | `/livestock-partners/aggregation-points` |
| aggregationpoint | `fetchAggregationPoint` | `/livestock-partners/aggregation-points/${encodeURIComponent(id)}` |
| certifiedlisting | `createCertifiedListing` | `/livestock-trade/listings` |
| certifiedlisting | `fetchCertifiedListing` | `/livestock-trade/listings/${encodeURIComponent(id)}` |
| equipmentlisting | `createEquipmentListing` | `/mechanization/listings` |
| equipmentlisting | `fetchEquipmentListing` | `/mechanization/listings/${encodeURIComponent(id)}` |
| farmplot | `createFarmPlot` | `/farms/plots` |
| farmplot | `fetchFarmPlot` | `/farms/plots/${encodeURIComponent(id)}` |
| lot | `createLot` | `/livestock/lots` |
| lot | `fetchLot` | `/livestock/lots/${encodeURIComponent(id)}` |
| myinsurancepolicies | `fetchMyInsurancePolicies` | `/insurance/policies/mine` |
| myinsurancepolicies | `listMyInsurancePolicies` | `/livestock-finance/insurance/policies/mine` |
| servicebooking | `createServiceBooking` | `/service-offerings/${encodeURIComponent(offeringId)}/bookings` |
| servicebooking | `fetchServiceBooking` | `/service-bookings/${encodeURIComponent(id)}` |
| warehousedeposit | `createWarehouseDeposit` | `/warehouse/deposits` |
| warehousedeposit | `fetchWarehouseDeposit` | `/warehouse/deposits/${encodeURIComponent(id)}` |
